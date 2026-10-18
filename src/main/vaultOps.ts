import { app, BrowserWindow, dialog, powerMonitor } from 'electron'
import { join } from 'path'
import type { VaultConfigInput, VaultStatus } from '@shared/types'
import * as vault from './vault'
import type { VaultPayload } from './vault'
import * as store from './storage'
import * as settings from './settings'
import { disconnectAll } from './db'
import { startMcp, stopMcp } from './mcp'

// Glue between the vault file and the rest of the main process: hands decrypted
// data to storage/settings, tears everything down on lock, and tells the
// renderer about locks and external changes.

const IDLE_POLL_MS = 30_000

function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function adopt(payload: VaultPayload): void {
  store.adoptVault(payload.catalog)
  settings.adoptVault(payload.settings)
}

function afterUnlock(payload: VaultPayload): VaultStatus {
  adopt(payload)
  startMcp()
  const s = vault.status()
  broadcast('vault:unlocked', s)
  return s
}

export function status(): VaultStatus {
  return vault.status()
}

/** Seal the current plaintext catalog and settings into a new vault, then remove them. */
export async function createVault(path: string, passphrase: string, touchId: boolean): Promise<VaultStatus> {
  const payload: VaultPayload = {
    catalog: store.exportForVault(),
    settings: settings.exportForVault()
  }
  await vault.createVault(path, passphrase, payload, touchId)
  adopt(payload)
  store.removePlaintextFile()
  settings.stripVaultPartsFromDisk()
  return vault.status()
}

/** Point this machine at an existing vault; its contents replace the local plaintext data. */
export async function openVault(path: string, passphrase: string, touchId: boolean): Promise<VaultStatus> {
  await disconnectAll()
  const payload = await vault.openVault(path, passphrase, touchId)
  settings.reset()
  const result = afterUnlock(payload)
  store.removePlaintextFile()
  settings.stripVaultPartsFromDisk()
  return result
}

export async function unlockWithPassphrase(passphrase: string, rememberTouchId: boolean): Promise<VaultStatus> {
  return afterUnlock(await vault.unlockWithPassphrase(passphrase, rememberTouchId))
}

export async function unlockWithTouchId(): Promise<VaultStatus> {
  return afterUnlock(await vault.unlockWithTouchId())
}

/** Close every database, forget the key and in-memory data, show the lock screen. */
export async function lock(): Promise<VaultStatus> {
  if (!vault.isConfigured() || !vault.isUnlocked()) return vault.status()
  stopMcp()
  await disconnectAll()
  vault.lock()
  store.reset()
  settings.reset()
  broadcast('vault:locked', vault.status())
  return vault.status()
}

export function setConfig(input: VaultConfigInput): VaultStatus {
  return vault.setConfig(input)
}

export async function pickLocation(mode: 'create' | 'open'): Promise<string | null> {
  const filters = [{ name: 'DataDock vault', extensions: ['ddvault'] }]
  if (mode === 'create') {
    const res = await dialog.showSaveDialog({
      title: 'Create vault',
      defaultPath: join(app.getPath('userData'), 'datadock.ddvault'),
      filters
    })
    return res.canceled || !res.filePath ? null : res.filePath
  }
  const res = await dialog.showOpenDialog({
    title: 'Open existing vault',
    properties: ['openFile'],
    filters
  })
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
}

/** Wire the vault to power events, idle time and external file changes. */
export function init(): void {
  vault.onReloaded((payload) => {
    adopt(payload)
    broadcast('vault:changed', vault.status())
  })
  vault.onForcedLock(async (reason) => {
    stopMcp()
    await disconnectAll()
    store.reset()
    settings.reset()
    broadcast('vault:locked', { ...vault.status(), reason })
  })

  powerMonitor.on('suspend', () => void lock())
  powerMonitor.on('lock-screen', () => void lock())

  const idle = setInterval(() => {
    const minutes = vault.status().autoLockMinutes
    if (!minutes || !vault.isUnlocked()) return
    if (powerMonitor.getSystemIdleTime() >= minutes * 60) void lock()
  }, IDLE_POLL_MS)
  idle.unref()
}
