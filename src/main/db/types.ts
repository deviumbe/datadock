import type {
  AlterOp,
  ConnectionConfig,
  CreateTableSpec,
  DropTableOptions,
  PoolStats,
  QueryResult,
  RowChangeSet,
  TableInfo,
  TableQueryOptions,
  TableSizeInfo,
  TableStructure
} from '@shared/types'

/**
 * A live driver instance for a single connection. Implementations are created
 * with fully-resolved (decrypted) config. `query` accepts arbitrary engine SQL
 * (or Flux for InfluxDB) and returns a uniform tabular result.
 */
export interface DbAdapter {
  readonly config: ConnectionConfig
  /** Open a throwaway connection to validate credentials, then close it. */
  test(): Promise<void>
  /** Establish the long-lived connection/pool held by the manager. */
  connect(): Promise<void>
  disconnect(): Promise<void>
  listTables(): Promise<TableInfo[]>
  tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult>
  query(sql: string): Promise<QueryResult>

  // Explicit transaction mode (queries run inside it until commit/rollback).
  beginTransaction?(): Promise<void>
  commitTransaction?(): Promise<void>
  rollbackTransaction?(): Promise<void>

  /** Map of table name -> column names, for editor autocomplete. */
  schema?(): Promise<Record<string, string[]>>
  /** Per-table row counts and on-disk sizes (largest first), for the size analyzer. */
  tableSizes?(): Promise<TableSizeInfo[]>
  /** Full entity-relationship model (tables, PK/FK columns, relations). */
  erModel?(): Promise<import('@shared/types').ErModel>
  /** Whole-database column snapshot, for schema diff. */
  schemaSnapshot?(): Promise<import('@shared/types').SchemaSnapshot>
  /** Live connection-pool diagnostics (best-effort). */
  poolStats?(): Promise<PoolStats>

  // Optional editing capabilities (SQL engines with primary keys).
  primaryKeys?(table: TableInfo): Promise<string[]>
  applyChanges?(table: TableInfo, changes: RowChangeSet): Promise<number>

  /** CREATE TABLE statement for structure export. */
  tableDDL?(table: TableInfo): Promise<string>

  /** Read columns + foreign keys for the structure editor. */
  tableStructure?(table: TableInfo): Promise<TableStructure>
  /** Apply a single structural change (one ALTER, in its own transaction). */
  alterTable?(table: TableInfo, op: AlterOp): Promise<void>
  /** Create a new table from column definitions. */
  createTable?(spec: CreateTableSpec): Promise<void>
  /** Drop one or more tables, honoring FK options. */
  dropTables?(tables: TableInfo[], opts: DropTableOptions): Promise<void>

  // Optional server-level capabilities (see DRIVER_CAPS).
  listDatabases?(): Promise<string[]>
  createDatabase?(name: string): Promise<void>
  dropDatabase?(name: string): Promise<void>
  listProcesses?(): Promise<QueryResult>
  killProcess?(id: string | number): Promise<void>
  listUsers?(): Promise<QueryResult>

  // Redis-specific capabilities (only the Redis adapter implements these).
  /** Full typed value of a single key, for the value viewer. */
  redisKeyValue?(key: string): Promise<import('@shared/types').RedisKeyValue>
  /** Server-wide stats parsed from INFO, for the queue dashboard header. */
  redisServerStats?(): Promise<import('@shared/types').RedisServerStats>
  /** Auto-discover queues across known frameworks (+ generic fallback). */
  redisQueues?(): Promise<import('@shared/types').QueueOverview[]>
  /** Fetch + parse jobs for one queue in a given state. */
  redisQueueJobs?(
    queue: string,
    state: import('@shared/types').QueueJobState,
    offset: number,
    limit: number
  ): Promise<import('@shared/types').QueueJob[]>
  /** Retry/delete a single job, or purge a whole queue state. */
  redisQueueAction?(
    action: import('@shared/types').QueueAction,
    queue: string,
    state: import('@shared/types').QueueJobState,
    jobId?: string
  ): Promise<void>
}

/** Reject identifiers that aren't safe to interpolate into DDL. */
export function assertIdent(name: string): string {
  if (!/^[A-Za-z0-9_$]+$/.test(name)) {
    throw new Error(`Invalid identifier: "${name}". Use letters, digits, _ or $ only.`)
  }
  return name
}

export function now(): number {
  return performance.now()
}

/** Parse a possibly-string/bigint catalog value into a number (or null). */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'bigint' ? Number(v) : Number(v)
  return Number.isFinite(n) ? n : null
}
