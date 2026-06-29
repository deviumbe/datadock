import { Redis, type RedisOptions } from 'ioredis'
import type {
  ColumnMeta,
  ConnectionConfig,
  QueryResult,
  QueueAction,
  QueueJob,
  QueueJobState,
  QueueOverview,
  RedisKeyType,
  RedisKeyValue,
  RedisServerStats,
  ReplicaLink,
  ReplicationStatus,
  RowChangeSet,
  TableInfo,
  TableQueryOptions,
  TableSizeInfo
} from '@shared/types'
import { DbAdapter, now } from './types'
import { discoverQueues, queueAction, queueJobs, queueOverview } from './redisQueues'

const NO_PREFIX = '(no prefix)'
const SCAN_CAP = 20000
/** How many collection elements to pull into a value preview / viewer. */
const VALUE_PREVIEW = 200

/**
 * Redis adapter. Redis is a key/value store, so we map it onto DataDock's
 * table/grid model by treating the segment before the first ':' as a pseudo-table
 * (e.g. `user:1`, `user:2` -> table "user"). The query editor accepts raw Redis
 * commands — e.g. `HGETALL user:1`, `LRANGE queues:default 0 10`, `SCAN 0`. The
 * "key" column acts as the primary key so the grid can delete keys and edit string
 * values inline. Server-level features map onto CLIENT LIST/KILL (Processes), and
 * the Redis-specific capabilities power the realtime queue dashboard.
 */
export class RedisAdapter implements DbAdapter {
  private client?: Redis
  constructor(public readonly config: ConnectionConfig) {}

  private options(): RedisOptions {
    return {
      host: this.config.host || '127.0.0.1',
      port: this.config.port || 6379,
      username: this.config.user || undefined,
      password: this.config.password || undefined,
      db: Number(this.config.database) || 0,
      tls: this.config.ssl ? {} : undefined,
      connectTimeout: 8000,
      maxRetriesPerRequest: 1,
      lazyConnect: true
    }
  }

  private get db(): Redis {
    if (!this.client) throw new Error('Connection is not open')
    return this.client
  }

  async test(): Promise<void> {
    const client = new Redis(this.options())
    try {
      await client.connect()
      await client.ping()
    } finally {
      client.disconnect()
    }
  }

  async connect(): Promise<void> {
    this.client = new Redis(this.options())
    await this.client.connect()
  }

  async disconnect(): Promise<void> {
    this.client?.disconnect()
    this.client = undefined
  }

  async replicationStatus(): Promise<ReplicationStatus> {
    try {
      const raw = await this.db.info('replication')
      const map: Record<string, string> = {}
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue
        const i = line.indexOf(':')
        if (i > 0) map[line.slice(0, i)] = line.slice(i + 1).trim()
      }
      if (map.role === 'slave') {
        const linkUp = map.master_link_status === 'up'
        const lastIo = map.master_last_io_seconds_ago != null ? Number(map.master_last_io_seconds_ago) : null
        return {
          detectedRole: 'replica',
          isPrimary: false,
          // No millisecond lag from Redis; seconds-since-last-IO is the best proxy.
          lagSeconds: linkUp ? Math.max(0, lastIo ?? 0) : null,
          position: map.slave_repl_offset,
          detail: [
            `Upstream ${map.master_host}:${map.master_port} · link ${map.master_link_status ?? '?'}`,
            ...(map.master_sync_in_progress === '1' ? ['Full resync in progress'] : [])
          ],
          error: linkUp ? undefined : 'Replication link is down'
        }
      }
      // master
      const replicas: ReplicaLink[] = []
      const n = Number(map.connected_slaves ?? 0)
      for (let i = 0; i < n; i++) {
        const entry = map[`slave${i}`]
        if (!entry) continue
        const f: Record<string, string> = {}
        for (const part of entry.split(',')) {
          const [k, v] = part.split('=')
          if (k) f[k] = v
        }
        replicas.push({
          name: `${f.ip ?? '?'}:${f.port ?? '?'}`,
          state: f.state,
          lagSeconds: f.lag != null ? Number(f.lag) : null
        })
      }
      return {
        detectedRole: 'primary',
        isPrimary: true,
        replicas,
        position: map.master_repl_offset,
        detail: replicas.length ? undefined : ['No connected replicas']
      }
    } catch (err) {
      return {
        detectedRole: 'unknown',
        isPrimary: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /** SCAN keys matching a pattern, capped to stay responsive. */
  private async scanKeys(match: string, cap = SCAN_CAP): Promise<string[]> {
    const out: string[] = []
    const stream = this.db.scanStream({ match, count: 500 })
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (keys: string[]) => {
        for (const k of keys) {
          out.push(k)
          if (out.length >= cap) {
            stream.pause()
            stream.destroy()
            resolve()
            return
          }
        }
      })
      stream.on('end', () => resolve())
      stream.on('close', () => resolve())
      stream.on('error', reject)
    })
    return out
  }

  /** Group the keyspace by the segment before the first ':' → pseudo-tables. */
  async listTables(): Promise<TableInfo[]> {
    const keys = await this.scanKeys('*')
    const prefixes = new Set<string>()
    for (const k of keys) {
      const i = k.indexOf(':')
      prefixes.add(i === -1 ? NO_PREFIX : k.slice(0, i))
    }
    return [...prefixes]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, type: 'table' as const }))
  }

  /** List the keys under one prefix with type / ttl / size / value preview. */
  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const start = now()
    const isNoPrefix = table.name === NO_PREFIX
    let keys = isNoPrefix
      ? (await this.scanKeys('*')).filter((k) => !k.includes(':'))
      : await this.scanKeys(`${table.name}:*`)

    // Client-side filtering on the key column (the grid sends generic filters).
    for (const f of opts.filters ?? []) {
      if (f.column !== 'key' || !f.value) continue
      const v = f.value.toLowerCase()
      if (f.op === 'contains') keys = keys.filter((k) => k.toLowerCase().includes(v))
      else if (f.op === 'starts') keys = keys.filter((k) => k.toLowerCase().startsWith(v))
      else if (f.op === '=') keys = keys.filter((k) => k === f.value)
    }
    keys.sort((a, b) => a.localeCompare(b))
    if (opts.sort?.column === 'key' && opts.sort.dir === 'desc') keys.reverse()

    const total = keys.length
    const page = keys.slice(opts.offset, opts.offset + opts.limit)

    // Pull type + ttl + memory for the page in one pipeline.
    const meta = this.db.pipeline()
    for (const k of page) {
      meta.type(k)
      meta.ttl(k)
      meta.memory('USAGE', k)
    }
    const metaRes = (await meta.exec()) ?? []

    const rows: unknown[][] = []
    for (let i = 0; i < page.length; i++) {
      const key = page[i]
      const type = (metaRes[i * 3]?.[1] as string) ?? 'none'
      const ttl = metaRes[i * 3 + 1]?.[1] as number
      const bytes = metaRes[i * 3 + 2]?.[1] as number | null
      const preview = await this.preview(key, type as RedisKeyType)
      rows.push([key, type, ttl === -1 ? null : ttl, bytes ?? null, preview])
    }

    return {
      columns: [
        { name: 'key' },
        { name: 'type' },
        { name: 'ttl' },
        { name: 'bytes' },
        { name: 'value' }
      ],
      rows,
      rowCount: total,
      durationMs: now() - start
    }
  }

  /** A short, grid-friendly preview of a key's value. */
  private async preview(key: string, type: RedisKeyType): Promise<string> {
    try {
      switch (type) {
        case 'string': {
          const v = (await this.db.get(key)) ?? ''
          return v.length > VALUE_PREVIEW ? `${v.slice(0, VALUE_PREVIEW)}…` : v
        }
        case 'list':
          return `[list · ${await this.db.llen(key)} items]`
        case 'set':
          return `{set · ${await this.db.scard(key)} members}`
        case 'zset':
          return `{zset · ${await this.db.zcard(key)} members}`
        case 'hash':
          return `{hash · ${await this.db.hlen(key)} fields}`
        case 'stream':
          return `{stream · ${await this.db.xlen(key)} entries}`
        default:
          return ''
      }
    } catch {
      return ''
    }
  }

  /** Treat the key as the primary key so the grid can delete + edit strings. */
  async primaryKeys(): Promise<string[]> {
    return ['key']
  }

  async applyChanges(_table: TableInfo, cs: RowChangeSet): Promise<number> {
    let affected = 0

    for (const pk of cs.deletes) {
      affected += await this.db.del(String(pk.key))
    }

    for (const e of cs.updates) {
      const key = String(e.pk.key)
      if ('value' in e.changes) {
        const type = await this.db.type(key)
        if (type !== 'string' && type !== 'none') {
          throw new Error(
            `Can't edit a ${type} value inline — open the value viewer for "${key}".`
          )
        }
        await this.db.set(key, String(e.changes.value ?? ''))
        affected++
      }
      if ('ttl' in e.changes) {
        const raw = e.changes.ttl
        const secs = raw === '' || raw == null ? -1 : Number(raw)
        if (Number.isFinite(secs) && secs > 0) await this.db.expire(key, secs)
        else await this.db.persist(key)
      }
    }

    for (const row of cs.inserts) {
      const key = row.key == null ? '' : String(row.key)
      if (!key) continue
      await this.db.set(key, String(row.value ?? ''))
      if (row.ttl != null && row.ttl !== '' && Number(row.ttl) > 0) {
        await this.db.expire(key, Number(row.ttl))
      }
      affected++
    }

    return affected
  }

  /** Run a single raw Redis command typed into the query editor. */
  async query(text: string): Promise<QueryResult> {
    const start = now()
    const tokens = tokenize(text.trim())
    if (!tokens.length) throw new Error('Empty command')
    const [cmd, ...args] = tokens
    const reply = await this.db.call(cmd.toUpperCase(), ...args)
    return { ...formatReply(cmd, reply), durationMs: now() - start }
  }

  async schema(): Promise<Record<string, string[]>> {
    // Pseudo-tables (prefixes) have no fixed columns; expose the grid columns.
    const tables = await this.listTables()
    const cols = ['key', 'type', 'ttl', 'bytes', 'value']
    return Object.fromEntries(tables.map((t) => [t.name, cols]))
  }

  async tableSizes(): Promise<TableSizeInfo[]> {
    const keys = await this.scanKeys('*')
    const counts = new Map<string, number>()
    for (const k of keys) {
      const i = k.indexOf(':')
      const prefix = i === -1 ? NO_PREFIX : k.slice(0, i)
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([name, rows]) => ({ name, rows, bytes: null }))
      .sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0))
  }

  // ---- Processes (CLIENT LIST / CLIENT KILL) --------------------------------

  async listProcesses(): Promise<QueryResult> {
    const start = now()
    const text = (await this.db.call('CLIENT', 'LIST')) as string
    const lines = text.split('\n').filter(Boolean)
    const parsed = lines.map((l) =>
      Object.fromEntries(l.split(' ').map((kv) => kv.split('=') as [string, string]))
    )
    const cols = ['id', 'addr', 'name', 'db', 'age', 'idle', 'cmd', 'user']
    return {
      columns: cols.map((name) => ({ name })),
      rows: parsed.map((p) => cols.map((c) => p[c] ?? '')),
      rowCount: parsed.length,
      durationMs: now() - start
    }
  }

  async killProcess(id: string | number): Promise<void> {
    await this.db.call('CLIENT', 'KILL', 'ID', String(id))
  }

  // ---- Redis-specific capabilities ------------------------------------------

  async redisKeyValue(key: string): Promise<RedisKeyValue> {
    const type = (await this.db.type(key)) as RedisKeyType
    const ttl = await this.db.ttl(key)
    const bytes = ((await this.db.memory('USAGE', key)) as number) ?? null
    let value: unknown = null
    let length: number | null = null
    let truncated = false

    switch (type) {
      case 'string': {
        const v = (await this.db.get(key)) ?? ''
        length = v.length
        value = v
        break
      }
      case 'list': {
        length = await this.db.llen(key)
        value = await this.db.lrange(key, 0, VALUE_PREVIEW - 1)
        truncated = (length ?? 0) > VALUE_PREVIEW
        break
      }
      case 'set': {
        length = await this.db.scard(key)
        value = await this.db.srandmember(key, VALUE_PREVIEW)
        truncated = (length ?? 0) > VALUE_PREVIEW
        break
      }
      case 'zset': {
        length = await this.db.zcard(key)
        const flat = await this.db.zrange(key, 0, VALUE_PREVIEW - 1, 'WITHSCORES')
        const pairs: { member: string; score: number }[] = []
        for (let i = 0; i < flat.length; i += 2) {
          pairs.push({ member: flat[i], score: Number(flat[i + 1]) })
        }
        value = pairs
        truncated = (length ?? 0) > VALUE_PREVIEW
        break
      }
      case 'hash': {
        const all = await this.db.hgetall(key)
        const entries = Object.entries(all).slice(0, VALUE_PREVIEW)
        length = Object.keys(all).length
        value = entries.map(([field, val]) => ({ field, value: val }))
        truncated = (length ?? 0) > VALUE_PREVIEW
        break
      }
      case 'stream': {
        length = await this.db.xlen(key)
        const entries = (await this.db.xrange(key, '-', '+', 'COUNT', VALUE_PREVIEW)) as [
          string,
          string[]
        ][]
        value = entries.map(([id, fields]) => ({ id, fields }))
        truncated = (length ?? 0) > VALUE_PREVIEW
        break
      }
      default:
        value = null
    }

    return { key, type, ttl, bytes, length, truncated, value }
  }

  async redisServerStats(): Promise<RedisServerStats> {
    const info = parseInfo(await this.db.info())
    const num = (k: string): number => Number(info[k] ?? 0)
    return {
      version: info.redis_version ?? '',
      uptimeSec: num('uptime_in_seconds'),
      usedMemoryBytes: num('used_memory'),
      maxMemoryBytes: num('maxmemory'),
      connectedClients: num('connected_clients'),
      opsPerSec: num('instantaneous_ops_per_sec'),
      totalCommands: num('total_commands_processed'),
      keyspaceHits: num('keyspace_hits'),
      keyspaceMisses: num('keyspace_misses'),
      totalKeys: await this.db.dbsize()
    }
  }

  async redisQueues(): Promise<QueueOverview[]> {
    const queues = await discoverQueues(this.db)
    const overviews = await Promise.all(queues.map((q) => queueOverview(this.db, q)))
    return overviews.sort((a, b) => b.pending + b.failed - (a.pending + a.failed))
  }

  async redisQueueJobs(
    name: string,
    state: QueueJobState,
    offset: number,
    limit: number
  ): Promise<QueueJob[]> {
    const queues = await discoverQueues(this.db)
    const q = queues.find((x) => x.name === name)
    if (!q) return []
    return queueJobs(this.db, q, state, offset, limit)
  }

  async redisQueueAction(
    action: QueueAction,
    name: string,
    state: QueueJobState,
    jobId?: string
  ): Promise<void> {
    const queues = await discoverQueues(this.db)
    const q = queues.find((x) => x.name === name)
    if (!q) return
    await queueAction(this.db, q, state, action, jobId)
  }
}

// ---- helpers ----------------------------------------------------------------

/** Quote-aware tokenizer for a single Redis command line. */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input))) {
    tokens.push(m[1] ?? m[2] ?? m[3])
  }
  return tokens
}

const PAIRED = new Set(['HGETALL', 'CONFIG'])

/** Turn a raw Redis reply into the uniform tabular QueryResult shape. */
function formatReply(cmd: string, reply: unknown): Omit<QueryResult, 'durationMs'> {
  const one = (cols: ColumnMeta[], rows: unknown[][]): Omit<QueryResult, 'durationMs'> => ({
    columns: cols,
    rows,
    rowCount: rows.length
  })

  if (reply === null || reply === undefined) return one([{ name: '(nil)' }], [[null]])

  if (Array.isArray(reply)) {
    // HGETALL / CONFIG GET come back as a flat [field, value, …] array.
    if (PAIRED.has(cmd.toUpperCase()) && reply.length % 2 === 0) {
      const rows: unknown[][] = []
      for (let i = 0; i < reply.length; i += 2) rows.push([scalar(reply[i]), scalar(reply[i + 1])])
      return one([{ name: 'field' }, { name: 'value' }], rows)
    }
    return one([{ name: 'value' }], reply.map((v) => [scalar(v)]))
  }

  return one([{ name: 'result' }], [[scalar(reply)]])
}

/** Render a single reply value as a grid-friendly scalar. */
function scalar(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (Buffer.isBuffer(v)) return v.toString()
  if (Array.isArray(v)) return JSON.stringify(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

/** Parse the `key:value` lines of an INFO reply (ignoring section headers). */
function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue
    const idx = l.indexOf(':')
    if (idx === -1) continue
    out[l.slice(0, idx)] = l.slice(idx + 1)
  }
  return out
}
