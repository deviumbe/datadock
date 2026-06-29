import {
  MongoClient,
  ObjectId,
  type AbstractCursor,
  type Db,
  type Document,
  type Filter,
  type Sort
} from 'mongodb'
import type {
  ConnectionConfig,
  FilterSpec,
  QueryResult,
  ReplicaLink,
  ReplicationRole,
  ReplicationStatus,
  RowChangeSet,
  TableInfo,
  TableQueryOptions,
  TableSizeInfo
} from '@shared/types'
import { DbAdapter, now } from './types'

/**
 * MongoDB adapter. Unlike the SQL engines this is a document store, so the
 * query editor accepts a shell-style expression — e.g.
 *   db.users.find({ active: true }).sort({ name: 1 }).limit(50)
 *   db.orders.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])
 *   db.users.countDocuments({ age: { $gte: 18 } })
 * "Tables" are surfaced as the collections in the configured database. Result
 * documents are flattened to columns (the union of their top-level keys, with
 * `_id` first); nested objects/arrays are shown as JSON.
 */
export class MongoAdapter implements DbAdapter {
  private client?: MongoClient
  constructor(public readonly config: ConnectionConfig) {}

  private uri(): string {
    const uri = this.config.url?.trim()
    if (!uri) throw new Error('No MongoDB connection URI configured')
    return uri
  }

  private get dbName(): string | undefined {
    return this.config.database?.trim() || undefined
  }

  private db(): Db {
    if (!this.client) throw new Error('Connection is not open')
    // If the database is omitted, fall back to the one encoded in the URI.
    return this.client.db(this.dbName)
  }

  async test(): Promise<void> {
    const client = new MongoClient(this.uri(), { serverSelectionTimeoutMS: 8000 })
    try {
      await client.connect()
      await client.db(this.dbName).command({ ping: 1 })
    } finally {
      await client.close()
    }
  }

  async connect(): Promise<void> {
    this.client = new MongoClient(this.uri(), { serverSelectionTimeoutMS: 8000 })
    await this.client.connect()
  }

  async disconnect(): Promise<void> {
    await this.client?.close()
    this.client = undefined
  }

  async replicationStatus(): Promise<ReplicationStatus> {
    if (!this.client) throw new Error('Connection is not open')
    try {
      const status = (await this.client.db('admin').command({ replSetGetStatus: 1 })) as {
        members?: { name: string; stateStr: string; optimeDate?: Date; self?: boolean }[]
      }
      const members = status.members ?? []
      const self = members.find((m) => m.self)
      const primary = members.find((m) => m.stateStr === 'PRIMARY')
      const primaryT = primary?.optimeDate ? new Date(primary.optimeDate).getTime() : null
      const selfIsPrimary = self?.stateStr === 'PRIMARY'

      const replicas: ReplicaLink[] = members
        .filter((m) => m.stateStr === 'SECONDARY')
        .map((m) => {
          const t = m.optimeDate ? new Date(m.optimeDate).getTime() : null
          return {
            name: m.name,
            state: m.stateStr,
            lagSeconds: primaryT && t ? Math.max(0, (primaryT - t) / 1000) : null
          }
        })

      let lagSeconds: number | null = null
      if (!selfIsPrimary && self?.optimeDate && primaryT) {
        lagSeconds = Math.max(0, (primaryT - new Date(self.optimeDate).getTime()) / 1000)
      }
      const detectedRole: ReplicationRole =
        self?.stateStr === 'ARBITER' ? 'arbiter' : selfIsPrimary ? 'primary' : 'replica'

      return {
        detectedRole,
        isPrimary: selfIsPrimary,
        lagSeconds: selfIsPrimary ? null : lagSeconds,
        replicas: selfIsPrimary ? replicas : undefined,
        detail: [
          `Replica set members: ${members.length}`,
          ...(self ? [`This node: ${self.stateStr}`] : [])
        ]
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const standalone = /--replSet|NoReplicationEnabled|not running with/i.test(msg)
      return {
        detectedRole: 'unknown',
        isPrimary: false,
        error: standalone ? 'Standalone mongod — not a replica set' : msg
      }
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const cols = await this.db().listCollections({}, { nameOnly: true }).toArray()
    return cols
      .filter((c) => !c.name.startsWith('system.'))
      .map((c) => ({ name: c.name, type: 'table' as const }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const start = now()
    const coll = this.db().collection(table.name)
    const filter = buildFilter(opts.filters)
    const cursor = coll.find(filter)
    if (opts.sort) cursor.sort({ [opts.sort.column]: opts.sort.dir === 'desc' ? -1 : 1 } as Sort)
    const docs = await cursor.skip(opts.offset).limit(opts.limit).toArray()
    return { ...toResult(docs), durationMs: now() - start }
  }

  async primaryKeys(): Promise<string[]> {
    // Every MongoDB document is uniquely identified by `_id`.
    return ['_id']
  }

  async applyChanges(table: TableInfo, cs: RowChangeSet): Promise<number> {
    const coll = this.db().collection(table.name)
    let affected = 0

    for (const pk of cs.deletes) {
      const res = await coll.deleteOne({ _id: coerceId(pk['_id']) } as Filter<Document>)
      affected += res.deletedCount
    }

    for (const e of cs.updates) {
      const set: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(e.changes)) set[k] = coerceValue(v)
      const res = await coll.updateOne(
        { _id: coerceId(e.pk['_id']) } as Filter<Document>,
        { $set: set }
      )
      affected += res.modifiedCount
    }

    for (const row of cs.inserts) {
      const doc: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) {
        if (k === '_id' && (v === '' || v == null)) continue // let Mongo assign it
        doc[k] = k === '_id' ? coerceId(v) : coerceValue(v)
      }
      await coll.insertOne(doc as Document)
      affected++
    }

    return affected
  }

  async schema(): Promise<Record<string, string[]>> {
    const map: Record<string, string[]> = {}
    const cols = await this.db().listCollections({}, { nameOnly: true }).toArray()
    for (const c of cols) {
      if (c.name.startsWith('system.')) continue
      const sample = await this.db().collection(c.name).find({}).limit(25).toArray()
      const keys = new Set<string>()
      for (const doc of sample) for (const k of Object.keys(doc)) keys.add(k)
      map[c.name] = [...keys]
    }
    return map
  }

  async tableSizes(): Promise<TableSizeInfo[]> {
    const cols = await this.db().listCollections({}, { nameOnly: true }).toArray()
    const out: TableSizeInfo[] = []
    for (const c of cols) {
      if (c.name.startsWith('system.')) continue
      try {
        const stats = (await this.db().command({ collStats: c.name })) as {
          count?: number
          storageSize?: number
          size?: number
        }
        out.push({
          name: c.name,
          rows: stats.count ?? null,
          bytes: stats.storageSize ?? stats.size ?? null
        })
      } catch {
        out.push({ name: c.name, rows: null, bytes: null })
      }
    }
    return out.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  }

  async query(text: string): Promise<QueryResult> {
    const start = now()
    const value = await evalMongo(text.trim(), this.db())

    if (value instanceof QueryCursor) {
      const docs = await value.toArray()
      return { ...toResult(docs), durationMs: now() - start }
    }
    if (Array.isArray(value)) {
      return { ...toResult(value as Document[]), durationMs: now() - start }
    }
    if (value && typeof value === 'object') {
      return { ...toResult([value as Document]), durationMs: now() - start }
    }
    // Scalar (countDocuments, distinct count, etc.) — show a single cell.
    return {
      columns: [{ name: 'result' }],
      rows: [[formatValue(value)]],
      rowCount: 1,
      durationMs: now() - start
    }
  }
}

// ---- query evaluation -------------------------------------------------------

/**
 * A wrapper around a Mongo find/aggregate cursor exposing chainable
 * `.sort/.limit/.skip`. Aggregation cursors don't support those directly (use
 * pipeline stages instead), so we surface a clear error rather than crashing.
 */
class QueryCursor {
  constructor(private readonly cursor: AbstractCursor<Document>) {}
  private call(method: 'sort' | 'limit' | 'skip', arg: unknown): this {
    const fn = (this.cursor as unknown as Record<string, unknown>)[method]
    if (typeof fn !== 'function') {
      throw new Error(`.${method}() isn't available here — use a $${method} pipeline stage instead.`)
    }
    ;(fn as (a: unknown) => unknown).call(this.cursor, arg)
    return this
  }
  sort(spec: Sort): this {
    return this.call('sort', spec)
  }
  limit(n: number): this {
    return this.call('limit', n)
  }
  skip(n: number): this {
    return this.call('skip', n)
  }
  toArray(): Promise<Document[]> {
    return this.cursor.toArray()
  }
}

/**
 * Evaluate a `db.<collection>.<method>(...)` expression. Read methods (find,
 * aggregate, countDocuments, distinct, …) are supported; the expression runs in
 * a constrained scope exposing only `db`, `ObjectId`, `ISODate` and `Date`.
 */
async function evalMongo(text: string, mongoDb: Db): Promise<unknown> {
  if (!text) throw new Error('Empty query')
  if (!/^db\s*\./.test(text)) {
    throw new Error('Query must start with `db.` — e.g. db.users.find({ active: true })')
  }

  const db = new Proxy(
    {},
    {
      get(_t, collName: string) {
        const coll = mongoDb.collection(collName)
        return {
          find: (filter: Filter<Document> = {}, projection?: Document) =>
            new QueryCursor(coll.find(filter, projection ? { projection } : {})),
          findOne: (filter: Filter<Document> = {}, projection?: Document) =>
            coll.findOne(filter, projection ? { projection } : {}),
          aggregate: (pipeline: Document[] = []) => new QueryCursor(coll.aggregate(pipeline)),
          countDocuments: (filter: Filter<Document> = {}) => coll.countDocuments(filter),
          estimatedDocumentCount: () => coll.estimatedDocumentCount(),
          distinct: (field: string, filter: Filter<Document> = {}) => coll.distinct(field, filter)
        }
      }
    }
  )

  const ISODate = (s?: string): Date => (s ? new Date(s) : new Date())
  let result: unknown
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('db', 'ObjectId', 'ISODate', 'Date', `return (${text});`)
    result = fn(db, ObjectId, ISODate, Date)
  } catch (err) {
    throw new Error(`Could not parse query: ${err instanceof Error ? err.message : String(err)}`)
  }
  return await result
}

// ---- value helpers ----------------------------------------------------------

/** Map the renderer's column filters onto a MongoDB query filter. */
function buildFilter(filters?: FilterSpec[]): Filter<Document> {
  const out: Record<string, unknown> = {}
  for (const f of filters ?? []) {
    if (!f.column) continue
    const v = f.value ?? ''
    switch (f.op) {
      case '=':
        out[f.column] = maybeNumber(v)
        break
      case '!=':
        out[f.column] = { $ne: maybeNumber(v) }
        break
      case '<':
        out[f.column] = { $lt: maybeNumber(v) }
        break
      case '<=':
        out[f.column] = { $lte: maybeNumber(v) }
        break
      case '>':
        out[f.column] = { $gt: maybeNumber(v) }
        break
      case '>=':
        out[f.column] = { $gte: maybeNumber(v) }
        break
      case 'contains':
        out[f.column] = { $regex: escapeRegex(v), $options: 'i' }
        break
      case 'starts':
        out[f.column] = { $regex: `^${escapeRegex(v)}`, $options: 'i' }
        break
      case 'is null':
        out[f.column] = null
        break
      case 'not null':
        out[f.column] = { $ne: null }
        break
    }
  }
  return out as Filter<Document>
}

/** Flatten a list of documents into the uniform tabular QueryResult shape. */
function toResult(docs: Document[]): Omit<QueryResult, 'durationMs'> {
  const names: string[] = []
  const seen = new Set<string>()
  // `_id` first, then keys in first-seen order across all documents.
  if (docs.some((d) => '_id' in d)) {
    names.push('_id')
    seen.add('_id')
  }
  for (const d of docs) {
    for (const k of Object.keys(d)) {
      if (!seen.has(k)) {
        seen.add(k)
        names.push(k)
      }
    }
  }
  const columns = names.map((n) => ({ name: n }))
  const rows = docs.map((d) => names.map((n) => formatValue((d as Record<string, unknown>)[n])))
  return { columns, rows, rowCount: rows.length }
}

/** Render a BSON/JS value as a grid-friendly scalar. */
function formatValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (v instanceof ObjectId) return v.toHexString()
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'bigint') return v.toString()
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

/** Turn an `_id` cell value back into an ObjectId when it looks like one. */
function coerceId(v: unknown): unknown {
  if (v instanceof ObjectId) return v
  if (typeof v === 'string' && /^[a-fA-F0-9]{24}$/.test(v)) return new ObjectId(v)
  return v
}

/** Coerce an edited cell (a string from the grid) back to a typed value. */
function coerceValue(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const s = v.trim()
  if (s === '') return ''
  if (s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return JSON.parse(s)
    } catch {
      /* keep as string */
    }
  }
  return v
}

function maybeNumber(v: string): string | number {
  return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
