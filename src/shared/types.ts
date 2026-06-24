// Shared type definitions used by the main process, preload, and renderer.

export type DriverType =
  | 'postgres'
  | 'mysql'
  | 'sqlite'
  | 'mssql'
  | 'influxdb'
  | 'mongodb'
  | 'redis'

export const DRIVERS: { type: DriverType; label: string; defaultPort?: number }[] = [
  { type: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { type: 'mysql', label: 'MySQL / MariaDB', defaultPort: 3306 },
  { type: 'sqlite', label: 'SQLite' },
  { type: 'mssql', label: 'SQL Server', defaultPort: 1433 },
  { type: 'mongodb', label: 'MongoDB', defaultPort: 27017 },
  { type: 'redis', label: 'Redis', defaultPort: 6379 },
  { type: 'influxdb', label: 'InfluxDB' }
]

/** Common column types offered in the "New table" dropdown, per engine. */
export const COLUMN_TYPES: Record<DriverType, string[]> = {
  postgres: [
    'integer', 'bigint', 'smallint', 'serial', 'bigserial', 'numeric', 'real',
    'double precision', 'boolean', 'text', 'varchar(255)', 'char(1)', 'date',
    'timestamp', 'timestamptz', 'time', 'uuid', 'json', 'jsonb', 'bytea'
  ],
  mysql: [
    'int', 'bigint', 'smallint', 'tinyint', 'decimal(10,2)', 'float', 'double',
    'boolean', 'varchar(255)', 'text', 'char(1)', 'date', 'datetime', 'timestamp',
    'time', 'json', 'blob'
  ],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'],
  mongodb: [],
  redis: [],
  mssql: [
    'int', 'bigint', 'smallint', 'tinyint', 'decimal(18,2)', 'float', 'bit',
    'varchar(255)', 'nvarchar(255)', 'char(1)', 'text', 'date', 'datetime',
    'datetime2', 'time', 'uniqueidentifier', 'varbinary(max)'
  ],
  influxdb: []
}

/**
 * A stored database connection. Secret fields (`password`, `token`) are only
 * ever held in plaintext transiently in the renderer form or the main-process
 * driver layer. At rest they are encrypted, and they are NEVER sent back to the
 * renderer — instead the booleans `hasPassword` / `hasToken` indicate presence.
 */
export interface ConnectionConfig {
  id: string
  name: string
  driver: DriverType
  color?: string
  /** Safe mode: block edits, inserts/deletes, DDL, imports and mutating SQL. */
  readOnly?: boolean
  /** Show a prominent red "PRODUCTION" banner for this connection. */
  production?: boolean

  // Network drivers (postgres, mysql, mssql)
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  hasPassword?: boolean
  ssl?: boolean

  // SQLite
  filePath?: string

  // InfluxDB (v2)
  url?: string
  token?: string
  hasToken?: boolean
  org?: string
  bucket?: string

  // SSH tunnel — connect to the SSH host, then reach the DB (host/port above
  // are interpreted relative to the SSH server, e.g. localhost:5432).
  sshEnabled?: boolean
  sshHost?: string
  sshPort?: number
  sshUser?: string
  sshAuthMethod?: 'key' | 'password' | 'agent'
  sshKeyPath?: string
  sshPassphrase?: string
  hasSshPassphrase?: boolean
  sshPassword?: string
  hasSshPassword?: boolean
}

export interface Environment {
  id: string
  name: string
  connections: ConnectionConfig[]
}

export interface Project {
  id: string
  name: string
  environments: Environment[]
}

export interface Workspace {
  projects: Project[]
}

export interface ColumnMeta {
  name: string
  type?: string
}

/** A normalized node in a query execution plan (for Visual EXPLAIN). */
export interface PlanNode {
  label: string
  detail?: string
  rows?: number
  cost?: number
  children: PlanNode[]
}

export interface QueryResult {
  columns: ColumnMeta[]
  rows: unknown[][]
  rowCount: number
  durationMs: number
  command?: string
  affectedRows?: number
}

export interface TableInfo {
  schema?: string
  name: string
  type: 'table' | 'view'
}

/** Row count + on-disk size for one table (Table Size analyzer). */
export interface TableSizeInfo {
  schema?: string
  name: string
  rows: number | null
  bytes: number | null
}

/** A point-in-time storage measurement for a connection (growth tracking). */
export interface SizeSnapshot {
  id: string
  connectionId: string
  at: string // ISO timestamp
  totalBytes: number
  tableCount: number
}

/** Live connection-pool diagnostics (best-effort; not all drivers report all). */
export interface PoolStats {
  /** Configured maximum pool size, if known. */
  max?: number
  /** Total connections currently in the pool (idle + in-use). */
  total?: number
  /** Connections currently idle/available. */
  idle?: number
  /** Connections currently checked out / in use. */
  active?: number
  /** Requests waiting for a free connection. */
  waiting?: number
}

// ---- Redis ------------------------------------------------------------------

export type RedisKeyType = 'string' | 'list' | 'set' | 'zset' | 'hash' | 'stream' | 'none'

/** Full value of a single Redis key, shaped per type, for the value viewer. */
export interface RedisKeyValue {
  key: string
  type: RedisKeyType
  /** Seconds to live, -1 = no expiry, -2 = missing. */
  ttl: number
  /** Best-effort serialized memory footprint in bytes. */
  bytes: number | null
  /** Number of elements (list/set/zset/hash/stream) or string length. */
  length: number | null
  /** Whether the value was truncated to a preview-sized slice. */
  truncated: boolean
  /**
   * string      -> string
   * list/set    -> string[]
   * zset        -> { member, score }[]
   * hash        -> { field, value }[]
   * stream      -> { id, fields }[]
   */
  value: unknown
}

/** Server-wide Redis stats parsed from INFO (for the queue dashboard header). */
export interface RedisServerStats {
  version: string
  uptimeSec: number
  usedMemoryBytes: number
  maxMemoryBytes: number
  connectedClients: number
  opsPerSec: number
  totalCommands: number
  keyspaceHits: number
  keyspaceMisses: number
  totalKeys: number
}

/** Which queue framework a discovered queue was recognized as. */
export type QueueFramework =
  | 'laravel'
  | 'horizon'
  | 'bullmq'
  | 'bull'
  | 'rq'
  | 'celery'
  | 'sidekiq'
  | 'generic'

/** One discovered queue with its per-state job counts. */
export interface QueueOverview {
  name: string
  framework: QueueFramework
  /** Jobs waiting to be processed. */
  pending: number
  /** Jobs scheduled for the future. */
  delayed: number
  /** Jobs currently reserved / in-flight. */
  reserved: number
  /** Jobs that have permanently failed. */
  failed: number
  /** Completed jobs, when the framework tracks them. */
  completed?: number
  /** The underlying Redis keys backing this queue (for drill-down). */
  keys: string[]
}

export type QueueJobState = 'pending' | 'delayed' | 'reserved' | 'failed' | 'completed'
export type QueueAction = 'retry' | 'delete' | 'purge'

/** A single parsed job within a queue. */
export interface QueueJob {
  /** Stable id when the framework assigns one. */
  id?: string
  state: QueueJobState
  framework: QueueFramework
  /** Job/class/handler name when parseable from the payload. */
  name?: string
  attempts?: number
  queue?: string
  /** ISO timestamp the job became available / failed, when known. */
  at?: string
  /** Parsed payload (best-effort JSON), else null. */
  payload: unknown
  /** Raw stored entry, for the raw view. */
  raw: string
  /** The exact value stored in the queue (raw for inline, id for hash-backed) —
   *  used as the identifier when removing the job. */
  member: string
  /** Failure message/exception, for failed jobs. */
  exception?: string
}

export interface SortSpec {
  column: string
  dir: 'asc' | 'desc'
}

export type FilterOp =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'contains'
  | 'starts'
  | 'is null'
  | 'not null'

export interface FilterSpec {
  column: string
  op: FilterOp
  value?: string
}

export interface TableQueryOptions {
  limit: number
  offset: number
  sort?: SortSpec
  filters?: FilterSpec[]
}

/** A single pending row update: original PK values + changed columns. */
export interface RowEdit {
  pk: Record<string, unknown>
  changes: Record<string, unknown>
}

/** A batch of pending changes committed together in one transaction. */
export interface RowChangeSet {
  updates: RowEdit[]
  inserts: Record<string, unknown>[]
  deletes: Record<string, unknown>[] // primary-key values per row
}

// ---- table structure --------------------------------------------------------

export interface ColumnDef {
  name: string
  type: string
  nullable: boolean
  default: string | null
  isPrimaryKey: boolean
}

export interface ForeignKeyDef {
  name: string
  column: string
  refTable: string
  refColumn: string
}

export interface IndexDef {
  name: string
  columns: string[]
  unique: boolean
}

export interface TableStructure {
  columns: ColumnDef[]
  foreignKeys: ForeignKeyDef[]
  indexes: IndexDef[]
}

// ---- ER diagram -------------------------------------------------------------

export interface ErColumn {
  name: string
  isPrimaryKey: boolean
  isForeignKey: boolean
}
export interface ErTable {
  name: string
  columns: ErColumn[]
}
export interface ErRelation {
  fromTable: string
  fromColumn: string
  toTable: string
  toColumn: string
}
export interface ErModel {
  tables: ErTable[]
  relations: ErRelation[]
}

// ---- schema snapshot (for schema diff) --------------------------------------

export interface SchemaColumn {
  name: string
  type: string
  nullable: boolean
  isPrimaryKey: boolean
}
export interface SchemaTable {
  name: string
  columns: SchemaColumn[]
}
export type SchemaSnapshot = SchemaTable[]

export type AlterOp =
  | { kind: 'addColumn'; name: string; type: string; nullable: boolean; default?: string }
  | { kind: 'dropColumn'; name: string }
  | { kind: 'renameColumn'; from: string; to: string }
  | { kind: 'changeType'; name: string; type: string }
  | { kind: 'setNullable'; name: string; nullable: boolean }
  | {
      kind: 'addForeignKey'
      name?: string
      column: string
      refTable: string
      refColumn: string
      onDelete?: string
    }
  | { kind: 'dropForeignKey'; name: string }
  | { kind: 'addIndex'; name?: string; columns: string[]; unique: boolean }
  | { kind: 'dropIndex'; name: string }

export interface NewColumn {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  default?: string
}

export interface CreateTableSpec {
  name: string
  schema?: string
  columns: NewColumn[]
}

export interface DropTableOptions {
  ignoreForeignKeys?: boolean
  cascade?: boolean
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

/** Server-level features a driver supports beyond querying tables. */
export interface DriverCapabilities {
  databases: boolean
  users: boolean
  processes: boolean
}

export const DRIVER_CAPS: Record<DriverType, DriverCapabilities> = {
  postgres: { databases: true, users: true, processes: true },
  mysql: { databases: true, users: true, processes: true },
  mssql: { databases: true, users: true, processes: true },
  sqlite: { databases: false, users: false, processes: false },
  mongodb: { databases: false, users: false, processes: false },
  // Redis has no users/createDatabase, but CLIENT LIST/KILL maps onto Processes.
  redis: { databases: false, users: false, processes: true },
  influxdb: { databases: false, users: false, processes: false }
}

// ---- import / export --------------------------------------------------------

export type ExportFormat = 'csv' | 'json' | 'xlsx' | 'sql'
export type DumpFormat = 'sql' | 'sql-zip'
export type TableDumpMode = 'structure' | 'data' | 'both' | 'skip'

export interface TableDumpSpec {
  schema?: string
  name: string
  mode: TableDumpMode
}

/** A result set handed from the renderer to the export writer. */
export interface ExportPayload {
  columns: ColumnMeta[]
  rows: unknown[][]
  tableName?: string
}

export interface FileResult {
  canceled: boolean
  path?: string
}

export interface ImportResult {
  statements?: number
  rowsInserted?: number
  errors: string[]
}

export interface HistoryEntry {
  id: string
  connectionId: string
  sql: string
  ranAt: string // ISO timestamp
  durationMs?: number
  rowCount?: number
  error?: string
}

export interface Snippet {
  id: string
  name: string
  sql: string
  description?: string
  createdAt: string
  updatedAt: string
}

// ---- settings / AI providers ------------------------------------------------

export type AiProvider = 'anthropic' | 'google' | 'mistral' | 'xai' | 'ollama'

/** Provider config as exposed to the renderer — never includes the raw key. */
export interface ProviderInfo {
  provider: AiProvider
  label: string
  /** False for local providers like Ollama that need no API key. */
  needsKey: boolean
  hasKey: boolean
  model: string
  defaultModel: string
  /** Server URL — only user-editable for Ollama. */
  baseUrl?: string
}

export type Density = 'comfortable' | 'compact'

export interface AppearanceSettings {
  /** UI zoom factor (1 = 100%). */
  fontScale: number
  density: Density
  pageSize: number
  theme: 'dark' | 'light'
}

export interface AppSettings {
  ai: {
    activeProvider: AiProvider
    providers: ProviderInfo[]
  }
  appearance: AppearanceSettings
}

/** A single message in a data-chat conversation. */
export interface ChatStep {
  sql: string
  rowCount?: number
  error?: string
}
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** Read-only queries the assistant ran to answer (assistant messages only). */
  steps?: ChatStep[]
}

/** Standard envelope returned by every IPC handler. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

// ---- Analytics module ------------------------------------------------------

/** Where a dataset's rows come from. */
export type DatasetSource =
  | { kind: 'table'; table: string }
  | { kind: 'view'; table: string }
  | { kind: 'sql'; sql: string }

/** A reusable, named query source for charts/metrics. */
export interface AnalyticsDataset {
  id: string
  connectionId: string
  name: string
  source: DatasetSource
  createdAt: string
  updatedAt: string
}

export type ChartType = 'bar' | 'hbar' | 'line' | 'area' | 'pie' | 'donut' | 'kpi' | 'table'
export type Aggregation = 'count' | 'sum' | 'avg' | 'min' | 'max'
/** Time bucketing applied to a temporal X dimension. */
export type TimeBucket = 'none' | 'day' | 'week' | 'month' | 'quarter' | 'year'

/** How dataset columns map onto a chart's axes/measures. */
export interface ChartEncoding {
  /** Dimension column for the X axis / category (omit for a single-value KPI). */
  x?: string
  bucket?: TimeBucket
  /** Aggregation applied to the measure. */
  yAgg: Aggregation
  /** Measure column. Omitted when yAgg is 'count'. */
  yColumn?: string
  /** Optional column to split into multiple series. */
  series?: string
  filters?: FilterSpec[]
  limit?: number
}

export interface AnalyticsChart {
  id: string
  connectionId: string
  datasetId: string
  name: string
  type: ChartType
  encoding: ChartEncoding
  /** Optional emoji shown on KPI cards (e.g. "💰"). */
  icon?: string
  createdAt: string
  updatedAt: string
}

/** One chart placed on a dashboard grid (12-column units). */
export interface AnalyticsDashboardWidget {
  chartId: string
  x: number
  y: number
  w: number
  h: number
}
export interface AnalyticsDashboard {
  id: string
  connectionId: string
  name: string
  widgets: AnalyticsDashboardWidget[]
  createdAt: string
  updatedAt: string
}

// ---- AI-generated analytics plan -------------------------------------------
// The AI returns an ordered list of operations. New objects are introduced with
// a local `key` (so later ops can reference them); existing objects are targeted
// by their real `id`. This lets the AI create, edit, fix or delete in place.

export interface AnalyticsOpWidget {
  /** An existing chart by id, or a chart created earlier in this plan by key. */
  chartId?: string
  chartKey?: string
  x?: number
  y?: number
  w?: number
  h?: number
}

export type AnalyticsOp =
  | { op: 'createDataset'; key: string; name: string; source: DatasetSource }
  | { op: 'updateDataset'; id: string; name?: string; source?: DatasetSource }
  | { op: 'deleteDataset'; id: string }
  | {
      op: 'createChart'
      key?: string
      name: string
      datasetId?: string
      datasetKey?: string
      type: ChartType
      encoding: ChartEncoding
      icon?: string
    }
  | {
      op: 'updateChart'
      id: string
      name?: string
      datasetId?: string
      datasetKey?: string
      type?: ChartType
      encoding?: ChartEncoding
      icon?: string
    }
  | { op: 'deleteChart'; id: string }
  | { op: 'createDashboard'; key?: string; name: string; widgets: AnalyticsOpWidget[] }
  | { op: 'updateDashboard'; id: string; name?: string; widgets?: AnalyticsOpWidget[] }
  | { op: 'deleteDashboard'; id: string }

export interface AnalyticsPlan {
  ops: AnalyticsOp[]
  /** Short natural-language summary of what was built/changed and any assumptions. */
  notes?: string
}

/** Snapshot of the connection's analytics objects, sent to the AI for context. */
export interface AnalyticsState {
  datasets: { id: string; name: string; source: DatasetSource }[]
  charts: {
    id: string
    name: string
    type: ChartType
    icon?: string
    datasetId: string
    encoding: ChartEncoding
  }[]
  dashboards: { id: string; name: string; widgets: AnalyticsDashboardWidget[] }[]
}
