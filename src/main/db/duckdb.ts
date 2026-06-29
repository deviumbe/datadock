import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api'
import type {
  AlterOp,
  ConnectionConfig,
  CreateTableSpec,
  DropTableOptions,
  TruncateOptions,
  ErModel,
  QueryResult,
  RowChangeSet,
  SchemaSnapshot,
  TableInfo,
  TableQueryOptions,
  TableSizeInfo,
  TableStructure
} from '@shared/types'
import { DbAdapter, now, toNum, assertIdent } from './types'
import { buildClauses, buildErModel, buildSnapshot } from './clauses'

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`

export class DuckDBAdapter implements DbAdapter {
  private instance?: DuckDBInstance
  private conn?: DuckDBConnection

  constructor(public readonly config: ConnectionConfig) {}

  private path(): string {
    if (!this.config.filePath) throw new Error('No DuckDB file path configured')
    return this.config.filePath
  }

  async test(): Promise<void> {
    const instance = await DuckDBInstance.create(this.path())
    const conn = await instance.connect()
    try {
      await conn.runAndReadAll('select 1')
    } finally {
      conn.disconnectSync()
    }
  }

  async connect(): Promise<void> {
    this.instance = await DuckDBInstance.create(this.path())
    this.conn = await this.instance.connect()
  }

  async disconnect(): Promise<void> {
    this.conn?.disconnectSync()
    this.conn = undefined
    this.instance = undefined
  }

  async beginTransaction(): Promise<void> {
    await this.conn!.run('begin')
  }
  async commitTransaction(): Promise<void> {
    await this.conn!.run('commit')
  }
  async rollbackTransaction(): Promise<void> {
    await this.conn!.run('rollback')
  }

  private async run(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const start = now()
    const reader = await this.conn!.runAndReadAll(sql, params as DuckDBValue[])
    const durationMs = now() - start
    const names = reader.columnNames()
    if (names.length) {
      const rows = reader.getRowsJS().map((r) => r.map(normalizeValue))
      return { columns: names.map((name) => ({ name })), rows, rowCount: rows.length, durationMs }
    }
    return { columns: [], rows: [], rowCount: 0, affectedRows: Number(reader.rowsChanged ?? 0), durationMs }
  }

  async query(sqlText: string): Promise<QueryResult> {
    return this.run(sqlText.replace(/;\s*$/, ''))
  }

  private ident(table: TableInfo): string {
    return table.schema ? `${q(table.schema)}.${q(table.name)}` : q(table.name)
  }

  async listTables(): Promise<TableInfo[]> {
    const res = await this.run(
      `select table_schema, table_name, table_type from information_schema.tables
        where table_schema not in ('information_schema', 'pg_catalog')
        order by table_schema, table_name`
    )
    return res.rows.map((r) => ({
      schema: r[0] == null ? undefined : String(r[0]),
      name: String(r[1]),
      type: String(r[2]).toUpperCase().includes('VIEW') ? 'view' : 'table'
    }))
  }

  async primaryKeys(table: TableInfo): Promise<string[]> {
    const res = await this.run(
      `select constraint_column_names from duckdb_constraints()
        where table_name = $1 and constraint_type = 'PRIMARY KEY'`,
      [table.name]
    )
    const cols = res.rows[0]?.[0]
    return Array.isArray(cols) ? cols.map(String) : []
  }

  async schema(): Promise<Record<string, string[]>> {
    const res = await this.run(
      `select table_name, column_name from information_schema.columns
        where table_schema not in ('information_schema', 'pg_catalog')
        order by table_name, ordinal_position`
    )
    const map: Record<string, string[]> = {}
    for (const r of res.rows) (map[String(r[0])] ??= []).push(String(r[1]))
    return map
  }

  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const { where, order, params } = buildClauses(opts, q, (i) => `$${i}`)
    return this.run(
      `select * from ${this.ident(table)}${where}${order} limit ${Number(opts.limit)} offset ${Number(opts.offset)}`,
      params
    )
  }

  async countRows(table: TableInfo, opts: TableQueryOptions): Promise<number> {
    const { where, params } = buildClauses(opts, q, (i) => `$${i}`)
    const res = await this.run(`select count(*) from ${this.ident(table)}${where}`, params)
    return Number(res.rows[0]?.[0] ?? 0)
  }

  async applyChanges(table: TableInfo, cs: RowChangeSet): Promise<number> {
    const t = this.ident(table)
    await this.conn!.run('begin')
    try {
      let affected = 0
      for (const pk of cs.deletes) {
        const params: unknown[] = []
        const where = Object.keys(pk)
          .map((c) => {
            params.push(pk[c])
            return `${q(c)} = $${params.length}`
          })
          .join(' and ')
        await this.run(`delete from ${t} where ${where}`, params)
        affected++
      }
      for (const e of cs.updates) {
        const params: unknown[] = []
        const set = Object.keys(e.changes)
          .map((c) => {
            params.push(e.changes[c])
            return `${q(c)} = $${params.length}`
          })
          .join(', ')
        const where = Object.keys(e.pk)
          .map((c) => {
            params.push(e.pk[c])
            return `${q(c)} = $${params.length}`
          })
          .join(' and ')
        await this.run(`update ${t} set ${set} where ${where}`, params)
        affected++
      }
      for (const row of cs.inserts) {
        const cols = Object.keys(row)
        if (!cols.length) continue
        const params = cols.map((c) => row[c])
        const names = cols.map(q).join(', ')
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ')
        await this.run(`insert into ${t} (${names}) values (${ph})`, params)
        affected++
      }
      await this.conn!.run('commit')
      return affected
    } catch (err) {
      await this.conn!.run('rollback').catch(() => undefined)
      throw err
    }
  }

  async tableSizes(): Promise<TableSizeInfo[]> {
    // estimated_size / column_count come from duckdb_tables(); row counts are exact.
    const res = await this.run(
      `select schema_name, table_name, estimated_size from duckdb_tables() order by estimated_size desc`
    )
    return res.rows.map((r) => ({
      schema: r[0] == null ? undefined : String(r[0]),
      name: String(r[1]),
      rows: toNum(r[2]),
      bytes: null
    }))
  }

  async tableStructure(table: TableInfo): Promise<TableStructure> {
    const cols = await this.run(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_name = $1${table.schema ? ' and table_schema = $2' : ''}
        order by ordinal_position`,
      table.schema ? [table.name, table.schema] : [table.name]
    )
    const pks = await this.primaryKeys(table)
    const fkRes = await this.run(
      `select constraint_column_names, referenced_table, referenced_column_names
         from duckdb_constraints()
        where table_name = $1 and constraint_type = 'FOREIGN KEY'`,
      [table.name]
    )
    const foreignKeys = fkRes.rows.flatMap((r) => {
      const fromCols = Array.isArray(r[0]) ? (r[0] as unknown[]).map(String) : []
      const refTable = r[1] == null ? '' : String(r[1])
      const refCols = Array.isArray(r[2]) ? (r[2] as unknown[]).map(String) : []
      return fromCols.map((col, i) => ({
        name: `fk_${table.name}_${col}`,
        column: col,
        refTable,
        refColumn: refCols[i] ?? refCols[0] ?? ''
      }))
    })
    return {
      columns: cols.rows.map((c) => ({
        name: String(c[0]),
        type: String(c[1]),
        nullable: String(c[2]).toUpperCase() === 'YES',
        default: c[3] == null ? null : String(c[3]),
        isPrimaryKey: pks.includes(String(c[0]))
      })),
      foreignKeys,
      indexes: [] // DuckDB indexes aren't introspectable as structured columns
    }
  }

  async tableDDL(table: TableInfo): Promise<string> {
    const s = await this.tableStructure(table)
    const lines = s.columns.map((c) => {
      let l = `  ${q(c.name)} ${c.type}`
      if (!c.nullable) l += ' not null'
      if (c.default) l += ` default ${c.default}`
      return l
    })
    const pks = s.columns.filter((c) => c.isPrimaryKey).map((c) => q(c.name))
    if (pks.length) lines.push(`  primary key (${pks.join(', ')})`)
    return `create table ${this.ident(table)} (\n${lines.join(',\n')}\n);`
  }

  async erModel(): Promise<ErModel> {
    const cols = await this.run(
      `select table_name, column_name from information_schema.columns
        where table_schema not in ('information_schema', 'pg_catalog')
        order by table_name, ordinal_position`
    )
    const pkRes = await this.run(
      `select table_name, constraint_column_names from duckdb_constraints()
        where constraint_type = 'PRIMARY KEY'`
    )
    const pkSet = new Set<string>()
    for (const r of pkRes.rows) {
      const t = String(r[0])
      if (Array.isArray(r[1])) for (const c of r[1] as unknown[]) pkSet.add(`${t}.${String(c)}`)
    }
    const fkRes = await this.run(
      `select table_name, constraint_column_names, referenced_table, referenced_column_names
         from duckdb_constraints() where constraint_type = 'FOREIGN KEY'`
    )
    const rels = fkRes.rows.flatMap((r) => {
      const t = String(r[0])
      const fromCols = Array.isArray(r[1]) ? (r[1] as unknown[]).map(String) : []
      const refTable = String(r[2] ?? '')
      const refCols = Array.isArray(r[3]) ? (r[3] as unknown[]).map(String) : []
      return fromCols.map((col, i) => ({
        fromTable: t,
        fromColumn: col,
        toTable: refTable,
        toColumn: refCols[i] ?? refCols[0] ?? ''
      }))
    })
    return buildErModel(
      cols.rows.map((r) => ({
        t: String(r[0]),
        col: String(r[1]),
        isPk: pkSet.has(`${String(r[0])}.${String(r[1])}`)
      })),
      rels
    )
  }

  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const cols = await this.run(
      `select table_name, column_name, data_type, is_nullable from information_schema.columns
        where table_schema not in ('information_schema', 'pg_catalog')
        order by table_name, ordinal_position`
    )
    const pkRes = await this.run(
      `select table_name, constraint_column_names from duckdb_constraints()
        where constraint_type = 'PRIMARY KEY'`
    )
    const pkSet = new Set<string>()
    for (const r of pkRes.rows) {
      const t = String(r[0])
      if (Array.isArray(r[1])) for (const c of r[1] as unknown[]) pkSet.add(`${t}.${String(c)}`)
    }
    return buildSnapshot(
      cols.rows.map((r) => ({
        t: String(r[0]),
        col: String(r[1]),
        type: String(r[2]),
        nullable: String(r[3]).toUpperCase() === 'YES',
        isPk: pkSet.has(`${String(r[0])}.${String(r[1])}`)
      }))
    )
  }

  async alterTable(table: TableInfo, op: AlterOp): Promise<void> {
    const t = this.ident(table)
    let sql: string
    switch (op.kind) {
      case 'addColumn':
        sql = `alter table ${t} add column ${q(assertIdent(op.name))} ${op.type}${op.default ? ` default ${op.default}` : ''}`
        break
      case 'dropColumn':
        sql = `alter table ${t} drop column ${q(op.name)}`
        break
      case 'renameColumn':
        sql = `alter table ${t} rename column ${q(op.from)} to ${q(assertIdent(op.to))}`
        break
      case 'changeType':
        sql = `alter table ${t} alter column ${q(op.name)} type ${op.type}`
        break
      case 'setNullable':
        sql = `alter table ${t} alter column ${q(op.name)} ${op.nullable ? 'drop not null' : 'set not null'}`
        break
      case 'addIndex': {
        const name = op.name || `idx_${table.name}_${op.columns.join('_')}`
        sql = `create ${op.unique ? 'unique ' : ''}index ${q(assertIdent(name))} on ${t} (${op.columns.map(q).join(', ')})`
        break
      }
      case 'dropIndex':
        sql = `drop index ${q(op.name)}`
        break
      default:
        throw new Error('DuckDB does not support altering foreign keys after table creation.')
    }
    await this.run(sql)
  }

  async createTable(spec: CreateTableSpec): Promise<void> {
    const ident = spec.schema ? `${q(spec.schema)}.${q(assertIdent(spec.name))}` : q(assertIdent(spec.name))
    const lines = spec.columns.map((c) => {
      let l = `${q(assertIdent(c.name))} ${c.type}`
      if (!c.nullable) l += ' not null'
      if (c.default) l += ` default ${c.default}`
      return l
    })
    const pks = spec.columns.filter((c) => c.primaryKey).map((c) => q(c.name))
    if (pks.length) lines.push(`primary key (${pks.join(', ')})`)
    await this.run(`create table ${ident} (${lines.join(', ')})`)
  }

  async dropTables(tables: TableInfo[], _opts: DropTableOptions): Promise<void> {
    for (const t of tables) await this.run(`drop table if exists ${this.ident(t)}`)
  }

  async truncateTables(tables: TableInfo[], _opts: TruncateOptions): Promise<void> {
    for (const t of tables) await this.run(`delete from ${this.ident(t)}`)
  }
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString('hex')}`
  if (Array.isArray(v)) return JSON.stringify(v)
  if (typeof v === 'object') {
    const s = String(v)
    return s === '[object Object]' ? JSON.stringify(v) : s
  }
  return v
}
