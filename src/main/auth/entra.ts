import { InteractiveBrowserCredential } from '@azure/identity'
import type { ConnectionConfig } from '@shared/types'

// Interactive Entra ID credentials, cached by connection (+ tenant), so a pool
// reconnect or a heal after a network blip can silently reuse MSAL's in-memory
// token cache instead of popping the browser open again. The cache only lives
// for the app session — signing in again after a restart is expected.
const entraCredentials = new Map<string, InteractiveBrowserCredential>()

export function entraCredential(config: ConnectionConfig): InteractiveBrowserCredential {
  const key = `${config.id}:${config.entraTenantId ?? ''}`
  let cred = entraCredentials.get(key)
  if (!cred) {
    // No clientId: falls back to Azure's well-known "Microsoft Azure CLI"
    // public client, which is pre-consented in virtually every tenant — no
    // app registration needed for this to work out of the box.
    cred = new InteractiveBrowserCredential({ tenantId: config.entraTenantId || undefined })
    entraCredentials.set(key, cred)
  }
  return cred
}

/** Azure Database for PostgreSQL (Flexible Server) token audience. */
export const AZURE_PG_ENTRA_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default'

export function isPostgresEntra(config: ConnectionConfig): boolean {
  return config.driver === 'postgres' && config.postgresAuthType === 'entra-interactive'
}

export function isMssqlEntra(config: ConnectionConfig): boolean {
  return config.driver === 'mssql' && config.mssqlAuthType === 'entra-interactive'
}

/**
 * Acquire an access token suitable as the PostgreSQL password. Never include
 * the token in thrown errors — it is a bearer credential.
 */
export async function entraPostgresAccessToken(config: ConnectionConfig): Promise<string> {
  const token = await entraCredential(config).getToken(AZURE_PG_ENTRA_SCOPE)
  if (!token?.token) {
    throw new Error('Microsoft Entra ID did not return an access token for Azure PostgreSQL.')
  }
  return token.token
}

/**
 * Role to send as the Postgres user: an explicit override, or the UPN from the
 * access-token claims. Group-name logins must set `config.user`.
 */
export function entraPostgresRole(config: ConnectionConfig, accessToken: string): string {
  const override = config.user?.trim()
  if (override) return override
  const upn = entraUpnFromAccessToken(accessToken)
  if (!upn) {
    throw new Error(
      'Could not determine the Entra user from the sign-in token. Enter the PostgreSQL role (UPN or group display name) in the connection form.'
    )
  }
  return upn
}

function entraUpnFromAccessToken(accessToken: string): string | undefined {
  const part = accessToken.split('.')[1]
  if (!part) return undefined
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4)
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>
    for (const claim of ['upn', 'preferred_username', 'unique_name'] as const) {
      const value = payload[claim]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  } catch {
    return undefined
  }
  return undefined
}

const ENTRA_PG_REJECTED_PREFIX = 'Microsoft Entra sign-in succeeded'

function pgErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  if (err instanceof Error && err.cause) return pgErrorCode(err.cause)
  return ''
}

export function isPostgresPasswordAuthFailure(err: unknown): boolean {
  if (err instanceof Error && err.message.startsWith(ENTRA_PG_REJECTED_PREFIX)) return false
  const code = pgErrorCode(err)
  const msg = err instanceof Error ? err.message : String(err)
  return code === '28P01' || /password authentication failed/i.test(msg)
}

export function postgresEntraAuthRejectedError(role: string, cause: unknown): Error {
  if (cause instanceof Error && cause.message.startsWith(ENTRA_PG_REJECTED_PREFIX)) return cause
  return new Error(
    `${ENTRA_PG_REJECTED_PREFIX}, but Azure PostgreSQL rejected the role "${role}". ` +
      `Grant that user or group on the Flexible Server, or set the role override for a group login.`,
    { cause: cause instanceof Error ? cause : undefined }
  )
}
