// Shared type definitions used by the main process, preload, and renderer.

export type DriverType = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'influxdb'

export const DRIVERS: { type: DriverType; label: string; defaultPort?: number }[] = [
  { type: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { type: 'mysql', label: 'MySQL / MariaDB', defaultPort: 3306 },
  { type: 'sqlite', label: 'SQLite' },
  { type: 'mssql', label: 'SQL Server', defaultPort: 1433 },
  { type: 'influxdb', label: 'InfluxDB' }
]

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

/** Standard envelope returned by every IPC handler. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
