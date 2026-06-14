import type {
  AlterOp,
  ConnectionConfig,
  CreateTableSpec,
  DropTableOptions,
  QueryResult,
  RowChangeSet,
  TableInfo,
  TableQueryOptions,
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
  /** Full entity-relationship model (tables, PK/FK columns, relations). */
  erModel?(): Promise<import('@shared/types').ErModel>
  /** Whole-database column snapshot, for schema diff. */
  schemaSnapshot?(): Promise<import('@shared/types').SchemaSnapshot>

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
