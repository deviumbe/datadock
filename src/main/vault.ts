import { app, safeStorage, systemPreferences } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'fs'
import { basename, dirname, join } from 'path'
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'crypto'
import { promisify } from 'util'
import type { Catalog, VaultConfigInput, VaultStatus } from '@shared/types'
import type { VaultSettings } from './settings'

// A single AES-256-GCM encrypted file holding the catalog and every secret-bearing
// setting. The key comes from the user's passphrase (scrypt), so the file can be
// synced through any cloud folder and opened on another machine with nothing but
// the passphrase. Touch ID is a convenience on top: the derived key is cached in
// this Mac's keychain (safeStorage) and released after a successful biometric
// prompt. The passphrase fallback is what keeps the vault portable — keychain
// items never leave the machine, and a new Mac has no key until the passphrase
// derives it once.

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

const FORMAT_VERSION = 1
const KDF = { N: 1 << 17, r: 8, p: 1 }
const KEY_BYTES = 32
const WATCH_DEBOUNCE_MS = 600

export interface VaultPayload {
  catalog: Catalog
  settings: VaultSettings
}

interface VaultConfig {
  path: string
  touchId: boolean
  autoLockMinutes: number
}

interface VaultHeader {
  datadock: 'vault'
  version: number
  revision: number
  updatedAt: string
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  cipher: 'aes-256-gcm'
  iv: string
  tag: string
  data: string
}

const DEFAULT_AUTO_LOCK_MINUTES = 15

let config: VaultConfig | undefined
let configLoaded = false
let key: Buffer | undefined
let kdf: VaultHeader['kdf'] | undefined
let revision = 0
let updatedAt: string | undefined
let payload: VaultPayload | undefined
let watcher: FSWatcher | undefined
let watchTimer: ReturnType<typeof setTimeout> | undefined

const reloadedListeners: ((p: VaultPayload) => void)[] = []
const lockedListeners: ((reason: string) => void)[] = []

export function onReloaded(cb: (p: VaultPayload) => void): void {
  reloadedListeners.push(cb)
}
export function onForcedLock(cb: (reason: string) => void): void {
  lockedListeners.push(cb)
}

// ---- local config (which file, Touch ID opt-in, idle minutes) -----------------

function configPath(): string {
  return join(app.getPath('userData'), 'vault.json')
}
function touchIdKeyPath(): string {
  return join(app.getPath('userData'), 'vault-touchid.key')
}

function loadConfig(): VaultConfig | undefined {
  if (configLoaded) return config
  configLoaded = true
  const p = configPath()
  if (!existsSync(p)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<VaultConfig>
    if (parsed.path) {
      config = {
        path: parsed.path,
        touchId: !!parsed.touchId,
        autoLockMinutes: parsed.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES
      }
    }
  } catch {
    config = undefined
  }
  return config
}

function saveConfig(next: VaultConfig): void {
  config = next
  configLoaded = true
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8')
}

export function isConfigured(): boolean {
  return !!loadConfig()
}
export function isUnlocked(): boolean {
  return !!key && !!payload
}
/** Vault mode and the key is in memory: storage and settings route through here. */
export function isActive(): boolean {
  return isConfigured() && isUnlocked()
}

export function touchIdAvailable(): boolean {
  return process.platform === 'darwin' && systemPreferences.canPromptTouchID()
}

export function status(): VaultStatus {
  const cfg = loadConfig()
  return {
    configured: !!cfg,
    unlocked: isUnlocked(),
    path: cfg?.path,
    fileExists: !!cfg && existsSync(cfg.path),
    touchIdAvailable: touchIdAvailable(),
    touchIdEnabled: !!cfg?.touchId && existsSync(touchIdKeyPath()),
    autoLockMinutes: cfg?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES,
    revision: isUnlocked() ? revision : undefined,
    updatedAt: isUnlocked() ? updatedAt : undefined
  }
}

export function getPayload(): VaultPayload {
  if (!payload) throw new Error('DataDock is locked')
  return payload
}

// ---- crypto -------------------------------------------------------------------

async function deriveKey(passphrase: string, params: VaultHeader['kdf']): Promise<Buffer> {
  return scrypt(passphrase.normalize('NFKC'), Buffer.from(params.salt, 'base64'), KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024
  })
}

/** The header fields GCM authenticates, so a tampered revision or salt fails to decrypt. */
function aad(version: number, rev: number, salt: string): Buffer {
  return Buffer.from(`${version}:${rev}:${salt}`, 'utf-8')
}

function encrypt(data: VaultPayload, k: Buffer, params: VaultHeader['kdf'], rev: number): VaultHeader {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  cipher.setAAD(aad(FORMAT_VERSION, rev, params.salt))
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf-8'), cipher.final()])
  return {
    datadock: 'vault',
    version: FORMAT_VERSION,
    revision: rev,
    updatedAt: new Date().toISOString(),
    kdf: params,
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64')
  }
}

function decrypt(header: VaultHeader, k: Buffer): VaultPayload {
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(header.iv, 'base64'))
  decipher.setAAD(aad(header.version, header.revision, header.kdf.salt))
  decipher.setAuthTag(Buffer.from(header.tag, 'base64'))
  let plain: string
  try {
    plain = Buffer.concat([
      decipher.update(Buffer.from(header.data, 'base64')),
      decipher.final()
    ]).toString('utf-8')
  } catch {
    throw new Error('Wrong passphrase, or the vault file is damaged.')
  }
  const parsed = JSON.parse(plain) as Partial<VaultPayload>
  if (!parsed.catalog || !parsed.settings) throw new Error('The vault file has unexpected contents.')
  return parsed as VaultPayload
}

function readHeader(path: string): VaultHeader {
  if (!existsSync(path)) throw new Error(`Vault file not found: ${path}`)
  let header: VaultHeader
  try {
    header = JSON.parse(readFileSync(path, 'utf-8')) as VaultHeader
  } catch {
    throw new Error('The vault file is not readable (incomplete sync, or not a DataDock vault).')
  }
  if (header.datadock !== 'vault' || header.kdf?.name !== 'scrypt' || header.cipher !== 'aes-256-gcm') {
    throw new Error('Not a DataDock vault file.')
  }
  if (header.version > FORMAT_VERSION) {
    throw new Error('This vault was written by a newer DataDock. Update the app to open it.')
  }
  return header
}

function writeAtomic(path: string, header: VaultHeader): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(header), 'utf-8')
  renameSync(tmp, path)
}

// ---- Touch ID key cache --------------------------------------------------------

function storeTouchIdKey(k: Buffer): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('The system keychain is unavailable, so Touch ID unlock cannot be set up.')
  }
  writeFileSync(touchIdKeyPath(), safeStorage.encryptString(k.toString('hex')))
}

function readTouchIdKey(): Buffer | undefined {
  const p = touchIdKeyPath()
  if (!existsSync(p)) return undefined
  try {
    return Buffer.from(safeStorage.decryptString(readFileSync(p)), 'hex')
  } catch {
    return undefined
  }
}

function dropTouchIdKey(): void {
  const p = touchIdKeyPath()
  if (existsSync(p)) unlinkSync(p)
}

// ---- state transitions -----------------------------------------------------------

function adopt(path: string, header: VaultHeader, k: Buffer, data: VaultPayload): void {
  key = k
  kdf = header.kdf
  revision = header.revision
  updatedAt = header.updatedAt
  payload = data
  startWatching(path)
}

async function openWith(
  path: string,
  passphrase: string,
  touchId: boolean,
  autoLockMinutes?: number
): Promise<VaultPayload> {
  const header = readHeader(path)
  const k = await deriveKey(passphrase, header.kdf)
  const data = decrypt(header, k)
  adopt(path, header, k, data)
  if (touchId) storeTouchIdKey(k)
  else dropTouchIdKey()
  saveConfig({
    path,
    touchId,
    autoLockMinutes: autoLockMinutes ?? loadConfig()?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES
  })
  return data
}

/** Encrypt `initial` into a brand-new vault at `path` and leave it unlocked. */
export async function createVault(
  path: string,
  passphrase: string,
  initial: VaultPayload,
  touchId: boolean
): Promise<void> {
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.')
  if (existsSync(path)) throw new Error('A file already exists at that location. Use "Open existing vault" instead.')
  const params: VaultHeader['kdf'] = { name: 'scrypt', ...KDF, salt: randomBytes(16).toString('base64') }
  const k = await deriveKey(passphrase, params)
  const header = encrypt(initial, k, params, 1)
  writeAtomic(path, header)
  adopt(path, header, k, initial)
  if (touchId) storeTouchIdKey(k)
  else dropTouchIdKey()
  saveConfig({ path, touchId, autoLockMinutes: loadConfig()?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES })
}

/** Switch this machine to an existing vault file (second Mac). */
export function openVault(path: string, passphrase: string, touchId: boolean): Promise<VaultPayload> {
  return openWith(path, passphrase, touchId)
}

export function unlockWithPassphrase(passphrase: string, rememberTouchId: boolean): Promise<VaultPayload> {
  const cfg = loadConfig()
  if (!cfg) throw new Error('No vault is configured.')
  // Keep an existing Touch ID opt-in (and refresh its cached key) even when the
  // checkbox was left unticked this time.
  const touchId = (cfg.touchId || rememberTouchId) && touchIdAvailable()
  return openWith(cfg.path, passphrase, touchId)
}

export async function unlockWithTouchId(): Promise<VaultPayload> {
  const cfg = loadConfig()
  if (!cfg) throw new Error('No vault is configured.')
  if (!cfg.touchId || !touchIdAvailable()) throw new Error('Touch ID unlock is not set up on this Mac.')
  const header = readHeader(cfg.path)
  const k = readTouchIdKey()
  if (!k) throw new Error('No Touch ID key is stored on this Mac. Unlock with your passphrase once to set it up.')
  await systemPreferences.promptTouchID('unlock DataDock')
  let data: VaultPayload
  try {
    data = decrypt(header, k)
  } catch {
    // The passphrase (and with it the salt/key) changed on another machine.
    dropTouchIdKey()
    throw new Error('The stored key no longer opens this vault. Unlock with your passphrase to refresh it.')
  }
  adopt(cfg.path, header, k, data)
  return data
}

export function lock(): void {
  stopWatching()
  key?.fill(0)
  key = undefined
  payload = undefined
  kdf = undefined
}

export function setConfig(input: VaultConfigInput): VaultStatus {
  const cfg = loadConfig()
  if (!cfg) throw new Error('No vault is configured.')
  const next = { ...cfg }
  if (input.autoLockMinutes !== undefined) {
    next.autoLockMinutes = Math.max(0, Math.min(24 * 60, Math.round(input.autoLockMinutes)))
  }
  if (input.touchId !== undefined) {
    if (input.touchId) {
      if (!key) throw new Error('Unlock the vault first.')
      storeTouchIdKey(key)
    } else {
      dropTouchIdKey()
    }
    next.touchId = input.touchId
  }
  saveConfig(next)
  return status()
}

// ---- writes -------------------------------------------------------------------------

/**
 * Re-encrypt the whole payload with the given sections replaced. Refuses to
 * clobber a newer revision written by another machine: that one is loaded
 * instead and the caller's change is reported back as lost.
 */
export function save(partial: Partial<VaultPayload>): void {
  const cfg = loadConfig()
  if (!cfg || !key || !payload || !kdf) throw new Error('DataDock is locked')
  if (existsSync(cfg.path)) {
    const onDisk = readHeader(cfg.path)
    if (onDisk.revision > revision) {
      reloadFrom(onDisk)
      throw new Error(
        'The vault was changed on another device and has been reloaded here. Please redo your change.'
      )
    }
  }
  const next: VaultPayload = { ...payload, ...partial }
  const header = encrypt(next, key, kdf, revision + 1)
  writeAtomic(cfg.path, header)
  payload = next
  revision = header.revision
  updatedAt = header.updatedAt
}

function reloadFrom(header: VaultHeader): void {
  if (!key) return
  const data = decrypt(header, key)
  payload = data
  revision = header.revision
  updatedAt = header.updatedAt
  for (const cb of reloadedListeners) cb(data)
}

// ---- file watching (another machine wrote the vault) --------------------------------------

function startWatching(path: string): void {
  stopWatching()
  const name = basename(path)
  try {
    // Watch the folder, not the file: atomic renames and cloud sync replace the inode.
    watcher = watch(dirname(path), (_event, file) => {
      if (file && file.toString() !== name) return
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => void checkDisk(path, 1), WATCH_DEBOUNCE_MS)
    })
    watcher.on('error', () => stopWatching())
  } catch {
    watcher = undefined
  }
}

function stopWatching(): void {
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = undefined
  watcher?.close()
  watcher = undefined
}

async function checkDisk(path: string, retriesLeft: number): Promise<void> {
  if (!key || !kdf) return
  let header: VaultHeader
  try {
    header = readHeader(path)
  } catch {
    // Cloud clients write in chunks; give the file a moment to settle.
    if (retriesLeft > 0) setTimeout(() => void checkDisk(path, retriesLeft - 1), 2000)
    return
  }
  if (header.revision <= revision && header.kdf.salt === kdf.salt) return
  try {
    reloadFrom(header)
  } catch {
    // A new salt means the passphrase was changed elsewhere: our key is void.
    lock()
    for (const cb of lockedListeners) cb('The vault was re-keyed on another device. Unlock with the new passphrase.')
  }
}
