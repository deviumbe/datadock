import type { ConnectionConfig } from '@shared/types'
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
