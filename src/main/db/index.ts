import type { ConnectionConfig, PlanNode } from '@shared/types'
import { DbAdapter } from './types'
import { PostgresAdapter } from './postgres'
import { MySQLAdapter } from './mysql'
import { SQLiteAdapter } from './sqlite'
import { MSSQLAdapter } from './mssql'
import { InfluxAdapter } from './influxdb'
import { openTunnel, type Tunnel } from './tunnel'

interface LiveConnection {
  adapter: DbAdapter
  tunnel?: Tunnel
}

/** Live, connected adapters keyed by connection id. */
const live = new Map<string, LiveConnection>()

export function createAdapter(config: ConnectionConfig): DbAdapter {
  switch (config.driver) {
    case 'postgres':
      return new PostgresAdapter(config)
    case 'mysql':
      return new MySQLAdapter(config)
    case 'sqlite':
      return new SQLiteAdapter(config)
    case 'mssql':
      return new MSSQLAdapter(config)
    case 'influxdb':
      return new InfluxAdapter(config)
    default:
      throw new Error(`Unsupported driver: ${(config as ConnectionConfig).driver}`)
  }
}

/** If SSH is enabled, open a tunnel and return config pointing at the local end. */
async function withTunnel(
  config: ConnectionConfig
): Promise<{ effective: ConnectionConfig; tunnel?: Tunnel }> {
  if (!config.sshEnabled) return { effective: config }
  const tunnel = await openTunnel(config)
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
  const { effective, tunnel } = await withTunnel(config)
  const adapter = createAdapter(effective)
  try {
    await adapter.connect()
  } catch (err) {
    tunnel?.close()
    throw err
  }
  live.set(config.id, { adapter, tunnel })
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
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...live.keys()].map((id) => disconnect(id)))
}

export function isConnected(id: string): boolean {
  return live.has(id)
}

export function getAdapter(id: string): DbAdapter {
  const conn = live.get(id)
  if (!conn) throw new Error('Connection is not open')
  return conn.adapter
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
  if (driver === 'postgres') {
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
