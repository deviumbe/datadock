import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import type {
  AiProvider,
  AppSettings,
  AppearanceSettings,
  McpSettings,
  ProviderInfo
} from '@shared/types'

// Application settings — AI provider keys (encrypted at rest with safeStorage,
// exactly like connection secrets and never sent to the renderer in plaintext)
// plus appearance preferences. The renderer only ever receives a sanitized view
// (key presence as a boolean, model + Ollama URL).

interface RawProvider {
  apiKey?: string
  model?: string
  baseUrl?: string
}
interface RawSettings {
  ai: { activeProvider: AiProvider; providers: Partial<Record<AiProvider, RawProvider>> }
  appearance: AppearanceSettings
  mcp: McpSettings
}

export const PROVIDER_META: Record<
  AiProvider,
  { label: string; needsKey: boolean; defaultModel: string; defaultBaseUrl?: string }
> = {
  anthropic: { label: 'Anthropic (Claude)', needsKey: true, defaultModel: 'claude-opus-4-8' },
  google: { label: 'Google (Gemini)', needsKey: true, defaultModel: 'gemini-2.5-flash' },
  mistral: { label: 'Mistral', needsKey: true, defaultModel: 'mistral-large-latest' },
  xai: { label: 'xAI (Grok)', needsKey: true, defaultModel: 'grok-2-latest' },
  ollama: {
    label: 'Ollama (local)',
    needsKey: false,
    defaultModel: 'llama3.1',
    defaultBaseUrl: 'http://localhost:11434'
  }
}

const DEFAULT_APPEARANCE: AppearanceSettings = {
  fontScale: 1,
  density: 'comfortable',
  pageSize: 200,
  theme: 'dark'
}

// MCP is off by default; a token is generated lazily the first time it's enabled.
const DEFAULT_MCP: McpSettings = {
  enabled: false,
  port: 4319,
  token: '',
  allowWrites: false
}

function newToken(): string {
  return randomBytes(24).toString('base64url')
}

let settingsPath: string | undefined
function path(): string {
  if (!settingsPath) settingsPath = join(app.getPath('userData'), 'settings.json')
  return settingsPath
}

function encrypt(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) return `plain:${plain}`
  return `enc:${safeStorage.encryptString(plain).toString('base64')}`
}
function decrypt(stored: string | undefined): string | undefined {
  if (!stored) return undefined
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    if (stored.startsWith('plain:')) return stored.slice(6)
  } catch {
    return undefined
  }
  return undefined
}

let cache: RawSettings | undefined

function blank(): RawSettings {
  return {
    ai: { activeProvider: 'anthropic', providers: {} },
    appearance: { ...DEFAULT_APPEARANCE },
    mcp: { ...DEFAULT_MCP }
  }
}

/** Pull an Anthropic key from the legacy ai.json (pre-multi-provider) once. */
function migrateLegacyKey(s: RawSettings): void {
  if (s.ai.providers.anthropic?.apiKey) return
  const legacy = join(app.getPath('userData'), 'ai.json')
  if (!existsSync(legacy)) return
  try {
    const data = JSON.parse(readFileSync(legacy, 'utf-8')) as { apiKey?: string }
    if (data.apiKey) {
      s.ai.providers.anthropic = { ...(s.ai.providers.anthropic ?? {}), apiKey: data.apiKey }
    }
  } catch {
    /* ignore a malformed legacy file */
  }
}

function load(): RawSettings {
  if (cache) return cache
  let s = blank()
  const p = path()
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<RawSettings>
      s = {
        ai: {
          activeProvider: parsed.ai?.activeProvider ?? 'anthropic',
          providers: parsed.ai?.providers ?? {}
        },
        appearance: { ...DEFAULT_APPEARANCE, ...(parsed.appearance ?? {}) },
        mcp: { ...DEFAULT_MCP, ...(parsed.mcp ?? {}) }
      }
    } catch {
      s = blank()
    }
  }
  migrateLegacyKey(s)
  cache = s
  return s
}

function save(): void {
  if (!cache) return
  writeFileSync(path(), JSON.stringify(cache, null, 2), 'utf-8')
}

function providerInfo(p: AiProvider, raw: RawSettings): ProviderInfo {
  const meta = PROVIDER_META[p]
  const cfg = raw.ai.providers[p]
  return {
    provider: p,
    label: meta.label,
    needsKey: meta.needsKey,
    hasKey: !!cfg?.apiKey,
    model: cfg?.model || meta.defaultModel,
    defaultModel: meta.defaultModel,
    baseUrl: cfg?.baseUrl || meta.defaultBaseUrl
  }
}

/** The sanitized settings safe to hand to the renderer (no raw keys). */
export function getSettings(): AppSettings {
  const raw = load()
  return {
    ai: {
      activeProvider: raw.ai.activeProvider,
      providers: (Object.keys(PROVIDER_META) as AiProvider[]).map((p) => providerInfo(p, raw))
    },
    appearance: { ...raw.appearance }
  }
}

export function setActiveProvider(p: AiProvider): AppSettings {
  const raw = load()
  raw.ai.activeProvider = p
  save()
  return getSettings()
}

export function setProviderKey(p: AiProvider, key: string): AppSettings {
  const raw = load()
  const cfg = (raw.ai.providers[p] ??= {})
  const trimmed = key.trim()
  if (trimmed) cfg.apiKey = encrypt(trimmed)
  else delete cfg.apiKey
  save()
  return getSettings()
}

export function clearProviderKey(p: AiProvider): AppSettings {
  const raw = load()
  if (raw.ai.providers[p]) delete raw.ai.providers[p]!.apiKey
  save()
  return getSettings()
}

export function setProviderConfig(
  p: AiProvider,
  config: { model?: string; baseUrl?: string }
): AppSettings {
  const raw = load()
  const cfg = (raw.ai.providers[p] ??= {})
  if (config.model !== undefined) cfg.model = config.model.trim() || undefined
  if (config.baseUrl !== undefined) cfg.baseUrl = config.baseUrl.trim() || undefined
  save()
  return getSettings()
}

export function setAppearance(partial: Partial<AppearanceSettings>): AppSettings {
  const raw = load()
  raw.appearance = { ...raw.appearance, ...partial }
  save()
  return getSettings()
}

// ---- MCP server settings ----------------------------------------------------

export function getMcpSettings(): McpSettings {
  return { ...load().mcp }
}

/** Merge a partial MCP config and persist. Generating a token when first needed. */
export function setMcpSettings(partial: Partial<McpSettings>): McpSettings {
  const raw = load()
  raw.mcp = { ...raw.mcp, ...partial }
  // Mint a token the first time the server is turned on so the UI can show it.
  if (raw.mcp.enabled && !raw.mcp.token) raw.mcp.token = newToken()
  save()
  return { ...raw.mcp }
}

export function regenerateMcpToken(): McpSettings {
  const raw = load()
  raw.mcp.token = newToken()
  save()
  return { ...raw.mcp }
}

// ---- internal accessors for the provider layer ------------------------------

export interface ResolvedProvider {
  provider: AiProvider
  apiKey?: string
  model: string
  baseUrl?: string
}

export function resolveProvider(p?: AiProvider): ResolvedProvider {
  const raw = load()
  const provider = p ?? raw.ai.activeProvider
  const meta = PROVIDER_META[provider]
  const cfg = raw.ai.providers[provider]
  return {
    provider,
    apiKey: decrypt(cfg?.apiKey),
    model: cfg?.model || meta.defaultModel,
    baseUrl: cfg?.baseUrl || meta.defaultBaseUrl
  }
}

/** Whether the active provider is usable (has a key, or is keyless like Ollama). */
export function activeProviderReady(): boolean {
  const raw = load()
  const p = raw.ai.activeProvider
  if (!PROVIDER_META[p].needsKey) return true
  return !!resolveProvider(p).apiKey
}
