import type { ConnectionConfig, ConnectionState, ConnStatePayload, PlanNode } from '@shared/types'
import { DbAdapter } from './types'
import { PostgresAdapter } from './postgres'
import { MySQLAdapter } from './mysql'
import { SQLiteAdapter } from './sqlite'
import { MSSQLAdapter } from './mssql'
import { MongoAdapter } from './mongodb'
import { InfluxAdapter } from './influxdb'
import { RedisAdapter } from './redis'
import { OracleAdapter } from './oracle'
import { DuckDBAdapter } from './duckdb'
import { ClickHouseAdapter } from './clickhouse'
import { SnowflakeAdapter } from './snowflake'
import { BigQueryAdapter } from './bigquery'
import { openTunnel, type Tunnel } from './tunnel'
import { resolveSshProfile } from '../settings'

interface LiveConnection {
  adapter: DbAdapter
  tunnel?: Tunnel
  /** Resolved (decrypted) config, kept so we can rebuild on heal. */
  config: ConnectionConfig
  state: ConnectionState
  error?: string
  verifiedAt?: number
  /** In-flight heal, so concurrent failures don't reconnect in parallel. */
  healing?: Promise<void>
}

/** Live, connected adapters keyed by connection id. */
const live = new Map<string, LiveConnection>()

// ---- connection-state machine ----------------------------------------------

const HEARTBEAT_TICK_MS = 10_000
const STALE_AFTER_MS = 25_000

let stateListener: ((p: ConnStatePayload) => void) | undefined
let isActive: () => boolean = () => true

/** Register the sink that forwards state transitions to the renderer. */
export function onConnState(fn: (p: ConnStatePayload) => void): void {
  stateListener = fn
}

/** Provide a probe for "is a window focused" — gates the heartbeat. */
export function setActivityProbe(fn: () => boolean): void {
  isActive = fn
}

function payload(id: string, conn?: LiveConnection): ConnStatePayload {
  if (!conn) return { id, state: 'disconnected' }
  return { id, state: conn.state, error: conn.error, verifiedAt: conn.verifiedAt }
}

/** Emit a transient state for an id that may not (yet) have a live record. */
function emitState(p: ConnStatePayload): void {
  stateListener?.(p)
}

function setState(id: string, state: ConnectionState, error?: string): void {
  const conn = live.get(id)
  if (!conn) {
    emitState({ id, state, error })
    return
  }
  conn.state = state
  conn.error = error
  if (state === 'connected') {
    conn.verifiedAt = Date.now()
    conn.error = undefined
  }
  emitState(payload(id, conn))
}

export function allStates(): ConnStatePayload[] {
  return [...live.entries()].map(([id, conn]) => payload(id, conn))
}

/** Errors that mean the link itself is gone (vs. a SQL/logic error). */
function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  const code = e?.code ?? ''
  if (/^(ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ENETUNREACH|EAI_AGAIN)$/.test(code)) {
    return true
  }
  const m = (e?.message ?? '').toLowerCase()
  return (
    m.includes('connection is not open') ||
    m.includes('connection terminated') ||
    m.includes('connection lost') ||
    m.includes('connection closed') ||
    m.includes('connection is closed') ||
    m.includes('server closed the connection') ||
    m.includes('terminating connection') ||
    m.includes('client has encountered a connection error') ||
    m.includes('read econnreset') ||
    m.includes('socket hang up') ||
    m.includes('tunnel') ||
    m.includes('econnrefused') ||
    m.includes('pool is draining') ||
    m.includes('cannot enqueue') ||
    m.includes('not queryable')
  )
}

/** Tear down the dead adapter/tunnel and rebuild both from the stored config. */
async function rebuild(conn: LiveConnection): Promise<void> {
  try {
    await conn.adapter.disconnect()
  } catch {
    /* already dead */
  }
  conn.tunnel?.close()
  conn.tunnel = undefined

  const id = conn.config.id
  const { effective, tunnel } = await withTunnel(conn.config, (err) => void markUnhealthy(id, err))
  const adapter = createAdapter(effective)
  try {
    await adapter.connect()
  } catch (err) {
    tunnel?.close()
    throw err
  }
  conn.adapter = adapter
  conn.tunnel = tunnel
  adapter.onConnectionLost = (err) => void markUnhealthy(id, err)
}

/** Mark a connection unhealthy and (unless it's production) heal it. */
function markUnhealthy(id: string, err: unknown): Promise<void> {
  const conn = live.get(id)
  if (!conn) return Promise.resolve()
  const message = err instanceof Error ? err.message : String(err)
  // Production connections don't auto-reconnect — a drop is a deliberate event.
  if (conn.config.production) {
    setState(id, 'unhealthy', message)
    return Promise.resolve()
  }
  return heal(id, message)
}

function heal(id: string, reason?: string): Promise<void> {
  const conn = live.get(id)
  if (!conn) return Promise.resolve()
  if (conn.healing) return conn.healing
  conn.healing = (async () => {
    setState(id, 'reconnecting', reason)
    try {
      await rebuild(conn)
      setState(id, 'connected')
    } catch (e) {
      setState(id, 'unhealthy', e instanceof Error ? e.message : String(e))
    } finally {
      conn.healing = undefined
    }
  })()
  return conn.healing
}

export function createAdapter(config: ConnectionConfig): DbAdapter {
  switch (config.driver) {
    case 'postgres':
    case 'cockroachdb':
    case 'timescaledb':
    case 'redshift':
      // All PostgreSQL wire-compatible — the Postgres adapter handles them.
      return new PostgresAdapter(config)
    case 'mysql':
      return new MySQLAdapter(config)
    case 'sqlite':
      return new SQLiteAdapter(config)
    case 'mssql':
      return new MSSQLAdapter(config)
    case 'oracle':
      return new OracleAdapter(config)
    case 'duckdb':
      return new DuckDBAdapter(config)
    case 'clickhouse':
      return new ClickHouseAdapter(config)
    case 'snowflake':
      return new SnowflakeAdapter(config)
    case 'bigquery':
      return new BigQueryAdapter(config)
    case 'mongodb':
      return new MongoAdapter(config)
    case 'redis':
      return new RedisAdapter(config)
    case 'influxdb':
      return new InfluxAdapter(config)
    default:
      throw new Error(`Unsupported driver: ${(config as ConnectionConfig).driver}`)
  }
}

/** Overlay a selected SSH profile's settings onto the connection. Profiles win
 * over the connection's legacy inline SSH fields. */
function withSshProfile(config: ConnectionConfig): ConnectionConfig {
  if (!config.sshProfileId) return config
  const profile = resolveSshProfile(config.sshProfileId)
  if (!profile) {
    throw new Error('SSH profile not found — re-select one in Settings → SSH Tunnels')
  }
  return {
    ...config,
    sshHost: profile.host,
    sshPort: profile.port,
    sshUser: profile.user,
    sshAuthMethod: profile.authMethod,
    sshKeyPath: profile.keyPath,
    sshPassphrase: profile.passphrase,
    sshPassword: profile.password
  }
}

/** If SSH is enabled, open a tunnel and return config pointing at the local end. */
async function withTunnel(
  config: ConnectionConfig,
  onClose?: (err?: Error) => void
): Promise<{ effective: ConnectionConfig; tunnel?: Tunnel }> {
  if (!config.sshEnabled) return { effective: config }
  const tunnel = await openTunnel(withSshProfile(config), onClose)
  return {
    effective: { ...config, host: tunnel.localHost, port: tunnel.localPort },
    tunnel
  }
}

export async function testConnection(config: ConnectionConfig): Promise<void> {
  const { effective, tunnel } = await withTunnel(config)
  try {
    await createAdapter(effective).test()
  } finally {
    tunnel?.close()
  }
}

export async function connect(config: ConnectionConfig): Promise<void> {
  await disconnect(config.id)
  setState(config.id, 'connecting')
  try {
    const { effective, tunnel } = await withTunnel(config, (err) =>
      void markUnhealthy(config.id, err)
    )
    const adapter = createAdapter(effective)
    try {
      await adapter.connect()
    } catch (err) {
      tunnel?.close()
      throw err
    }
    const conn: LiveConnection = {
      adapter,
      tunnel,
      config,
      state: 'connected',
      verifiedAt: Date.now()
    }
    adapter.onConnectionLost = (err) => void markUnhealthy(config.id, err)
    live.set(config.id, conn)
    emitState(payload(config.id, conn))
  } catch (err) {
    setState(config.id, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
}

export async function disconnect(id: string): Promise<void> {
  const conn = live.get(id)
  if (!conn) return
  live.delete(id)
  try {
    await conn.adapter.disconnect()
  } catch {
    // best-effort teardown
  }
  conn.tunnel?.close()
  emitState({ id, state: 'disconnected' })
}

// ---- liveness: heartbeat + on-demand verification ---------------------------

/** Ping one connection and reconcile its state. */
async function verify(id: string): Promise<void> {
  const conn = live.get(id)
  if (!conn || conn.healing) return
  try {
    // Adapters without a cheap probe (some newer engines) are assumed alive here;
    // a failing real query will still mark them unhealthy on its own.
    await conn.adapter.ping?.()
    if (conn.state !== 'connected') setState(id, 'connected')
    else conn.verifiedAt = Date.now()
  } catch (err) {
    await markUnhealthy(id, err)
  }
}

/** Re-check every live connection now (e.g. on machine resume / window focus). */
export async function verifyAll(): Promise<void> {
  await Promise.all([...live.keys()].map((id) => verify(id)))
}

let heartbeat: ReturnType<typeof setInterval> | undefined
export function startHeartbeat(): void {
  if (heartbeat) return
  heartbeat = setInterval(() => {
    if (!isActive()) return
    const now = Date.now()
    for (const [id, conn] of live) {
      if (conn.state !== 'connected' || conn.healing) continue
      if (now - (conn.verifiedAt ?? 0) < STALE_AFTER_MS) continue
      void verify(id)
    }
  }, HEARTBEAT_TICK_MS)
  heartbeat.unref?.()
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...live.keys()].map((id) => disconnect(id)))
}

export function isConnected(id: string): boolean {
  return live.has(id)
}

/** Cancel any in-flight query on a connection (no-op if unsupported/idle). */
export async function cancelQuery(id: string): Promise<void> {
  await live.get(id)?.adapter.cancelQuery?.()
}

// Read-only operations are safe to auto-retry once after a transparent heal.
// Mutating operations (query, applyChanges, alterTable…) are not — a partial
// write must not be silently replayed.
const RETRYABLE_OPS = new Set<string>([
  'ping',
  'listTables',
  'tableData',
  'countRows',
  'schema',
  'tableSizes',
  'erModel',
  'schemaSnapshot',
  'tableStructure',
  'tableDDL',
  'primaryKeys',
  'listDatabases',
  'listProcesses',
  'listUsers',
  'poolStats',
  'redisKeyValue',
  'redisServerStats',
  'redisQueues',
  'redisQueueJobs'
])

/**
 * Return the live adapter wrapped so every call participates in the state
 * machine: a connection-level failure marks the connection unhealthy and kicks
 * off a heal; read-only ops are retried once on the rebuilt connection.
 */
export function getAdapter(id: string): DbAdapter {
  const conn = live.get(id)
  if (!conn) throw new Error('Connection is not open')
  return new Proxy(conn.adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof prop === 'symbol' || prop === 'then' || typeof value !== 'function') {
        return value
      }
      const name = prop
      return async (...args: unknown[]): Promise<unknown> => {
        const current = live.get(id)?.adapter ?? target
        try {
          return await (current[name as keyof DbAdapter] as Function).apply(current, args)
        } catch (err) {
          if (!isConnectionError(err)) throw err
          const healed = markUnhealthy(id, err)
          if (RETRYABLE_OPS.has(name) && !conn.config.production) {
            await healed
            const next = live.get(id)
            if (next && next.state === 'connected') {
              return await (next.adapter[name as keyof DbAdapter] as Function).apply(
                next.adapter,
                args
              )
            }
          }
          throw err
        }
      }
    }
  })
}

// ---- Visual EXPLAIN ---------------------------------------------------------

interface PgPlan {
  'Node Type'?: string
  'Relation Name'?: string
  'Index Name'?: string
  'Join Type'?: string
  'Filter'?: string
  'Index Cond'?: string
  'Hash Cond'?: string
  'Sort Key'?: string[]
  'Plan Rows'?: number
  'Total Cost'?: number
  'Plans'?: PgPlan[]
}

/** Build a normalized PlanNode tree from a Postgres `FORMAT JSON` plan node. */
function pgNode(p: PgPlan): PlanNode {
  const type = p['Node Type'] ?? 'Node'
  const target = p['Relation Name'] ?? p['Index Name']
  const label = target ? `${type} on ${target}` : type
  const detailParts: string[] = []
  if (p['Join Type']) detailParts.push(`${p['Join Type']} Join`)
  if (p['Index Cond']) detailParts.push(`Index Cond: ${p['Index Cond']}`)
  if (p['Hash Cond']) detailParts.push(`Hash Cond: ${p['Hash Cond']}`)
  if (p['Filter']) detailParts.push(`Filter: ${p['Filter']}`)
  if (p['Sort Key']?.length) detailParts.push(`Sort Key: ${p['Sort Key'].join(', ')}`)
  return {
    label,
    detail: detailParts.length ? detailParts.join(' · ') : undefined,
    rows: p['Plan Rows'],
    cost: p['Total Cost'],
    children: (p['Plans'] ?? []).map(pgNode)
  }
}

/** Build a PlanNode tree from SQLite `EXPLAIN QUERY PLAN` adjacency rows. */
function sqliteTree(rows: unknown[][]): PlanNode {
  const root: PlanNode = { label: 'QUERY PLAN', children: [] }
  const byId = new Map<number, PlanNode>()
  byId.set(0, root)
  for (const r of rows) {
    const id = Number(r[0])
    const parent = Number(r[1])
    const detail = String(r[3] ?? '')
    const node: PlanNode = { label: detail, children: [] }
    byId.set(id, node)
    const parentNode = byId.get(parent) ?? root
    parentNode.children.push(node)
  }
  return root
}

/**
 * Produce a structured execution plan for engines that expose one (Postgres,
 * SQLite). Returns null for engines without a structured plan — the caller
 * falls back to the flat textual EXPLAIN.
 */
export async function explainPlan(id: string, sql: string): Promise<PlanNode | null> {
  const adapter = getAdapter(id)
  const driver = adapter.config.driver
  // TimescaleDB is real Postgres, so it supports the JSON-format plan too.
  // CockroachDB/Redshift differ here — they fall back to the flat text EXPLAIN.
  if (driver === 'postgres' || driver === 'timescaledb') {
    const res = await adapter.query(`EXPLAIN (FORMAT JSON, COSTS true) ${sql}`)
    const cell = res.rows?.[0]?.[0]
    const parsed = typeof cell === 'string' ? JSON.parse(cell) : cell
    const root = Array.isArray(parsed) ? parsed[0]?.Plan : (parsed as { Plan?: PgPlan })?.Plan
    return root ? pgNode(root as PgPlan) : null
  }
  if (driver === 'sqlite') {
    const res = await adapter.query(`EXPLAIN QUERY PLAN ${sql}`)
    return sqliteTree(res.rows as unknown[][])
  }
  return null
}

/** Invoke an optional capability, with a clear error when unsupported. */
export function capability<K extends keyof DbAdapter>(
  id: string,
  name: K
): NonNullable<DbAdapter[K]> {
  const adapter = getAdapter(id)
  const fn = adapter[name]
  if (typeof fn !== 'function') {
    throw new Error(`${adapter.config.driver} does not support "${String(name)}"`)
  }
  return (fn as Function).bind(adapter)
}
