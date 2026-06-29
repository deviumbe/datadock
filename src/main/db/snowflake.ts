import snowflake, { type Connection } from 'snowflake-sdk'
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

// Quiet the SDK's verbose default logging.
snowflake.configure({ logLevel: 'ERROR' })

export class SnowflakeAdapter implements DbAdapter {
  private conn?: Connection
  constructor(public readonly config: ConnectionConfig) {}

  private make(): Connection {
    if (!this.config.account) throw new Error('Snowflake account is required')
    return snowflake.createConnection({
      account: this.config.account,
      username: this.config.user,
      password: this.config.password,
      database: this.config.database || undefined,
      schema: this.config.schema || undefined,
      warehouse: this.config.warehouse || undefined,
      role: this.config.role || undefined
    })
  }

  private connectAsync(conn: Connection): Promise<void> {
    return new Promise((resolve, reject) => {
      conn.connect((err) => (err ? reject(err) : resolve()))
    })
  }

  async test(): Promise<void> {
    const conn = this.make()
    await this.connectAsync(conn)
    await new Promise<void>((resolve, reject) => {
      conn.destroy((err) => (err ? reject(err) : resolve()))
    })
  }

  async connect(): Promise<void> {
    this.conn = this.make()
    await this.connectAsync(this.conn)
  }

  async disconnect(): Promise<void> {
    const conn = this.conn
    this.conn = undefined
    if (!conn) return
    await new Promise<void>((resolve) => conn.destroy(() => resolve()))
  }

  private exec(sqlText: string, binds: unknown[] = []): Promise<QueryResult> {
    const start = now()
    return new Promise((resolve, reject) => {
      this.conn!.execute({
        sqlText,
        binds: binds as snowflake.Binds,
        complete: (err, stmt, rows) => {
          if (err) return reject(err)
          const cols = (stmt.getColumns?.() ?? []).map((c) => c.getName())
          const durationMs = now() - start
          if (cols.length) {
            const out = (rows ?? []).map((row) => cols.map((c) => normalizeValue((row as Record<string, unknown>)[c])))
            resolve({ columns: cols.map((name) => ({ name })), rows: out, rowCount: out.length, durationMs })
          } else {
            resolve({
              columns: [],
              rows: [],
              rowCount: 0,
              affectedRows: stmt.getNumUpdatedRows?.() ?? 0,
              durationMs
            })
          }
        }
      })
    })
  }

  async query(sqlText: string): Promise<QueryResult> {
    return this.exec(sqlText.replace(/;\s*$/, ''))
  }

  private ident(table: TableInfo): string {
    return table.schema ? `${q(table.schema)}.${q(table.name)}` : q(table.name)
  }

  async listTables(): Promise<TableInfo[]> {
    const res = await this.exec(
      `select table_schema, table_name, table_type from information_schema.tables
        where table_schema <> 'INFORMATION_SCHEMA' order by table_schema, table_name`
    )
    return res.rows.map((r) => ({
      schema: r[0] == null ? undefined : String(r[0]),
      name: String(r[1]),
      type: String(r[2]).toUpperCase().includes('VIEW') ? 'view' : 'table'
    }))
  }

  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const { where, order, params } = buildClauses(opts, q, () => '?')
    return this.exec(
      `select * from ${this.ident(table)}${where}${order} limit ${Number(opts.limit)} offset ${Number(opts.offset)}`,
      params
    )
  }

  async countRows(table: TableInfo, opts: TableQueryOptions): Promise<number> {
    const { where, params } = buildClauses(opts, q, () => '?')
    const res = await this.exec(`select count(*) from ${this.ident(table)}${where}`, params)
    return Number(res.rows[0]?.[0] ?? 0)
  }

  async primaryKeys(table: TableInfo): Promise<string[]> {
    const res = await this.exec(`show primary keys in table ${this.ident(table)}`)
    const idx = res.columns.findIndex((c) => c.name.toLowerCase() === 'column_name')
    if (idx < 0) return []
    return res.rows.map((r) => String(r[idx]))
  }

  async schema(): Promise<Record<string, string[]>> {
    const res = await this.exec(
      `select table_name, column_name from information_schema.columns
        where table_schema <> 'INFORMATION_SCHEMA' order by table_name, ordinal_position`
    )
    const map: Record<string, string[]> = {}
    for (const r of res.rows) (map[String(r[0])] ??= []).push(String(r[1]))
    return map
  }

  async applyChanges(table: TableInfo, cs: RowChangeSet): Promise<number> {
    const t = this.ident(table)
    let affected = 0
    for (const pk of cs.deletes) {
      const binds: unknown[] = []
      const where = Object.keys(pk).map((c) => (binds.push(pk[c]), `${q(c)} = ?`)).join(' and ')
      await this.exec(`delete from ${t} where ${where}`, binds)
      affected++
    }
    for (const e of cs.updates) {
      const binds: unknown[] = []
      const set = Object.keys(e.changes).map((c) => (binds.push(e.changes[c]), `${q(c)} = ?`)).join(', ')
      const where = Object.keys(e.pk).map((c) => (binds.push(e.pk[c]), `${q(c)} = ?`)).join(' and ')
      await this.exec(`update ${t} set ${set} where ${where}`, binds)
      affected++
    }
    for (const row of cs.inserts) {
      const cols = Object.keys(row)
      if (!cols.length) continue
      const binds = cols.map((c) => row[c])
      const ph = cols.map(() => '?').join(', ')
      await this.exec(`insert into ${t} (${cols.map(q).join(', ')}) values (${ph})`, binds)
      affected++
    }
    return affected
  }

  async tableSizes(): Promise<TableSizeInfo[]> {
    const res = await this.exec(
      `select table_schema, table_name, row_count, bytes from information_schema.tables
        where table_schema <> 'INFORMATION_SCHEMA' and table_type = 'BASE TABLE'
        order by bytes desc nulls last`
    )
    return res.rows.map((r) => ({
      schema: r[0] == null ? undefined : String(r[0]),
      name: String(r[1]),
      rows: toNum(r[2]),
      bytes: toNum(r[3])
    }))
  }

  async tableStructure(table: TableInfo): Promise<TableStructure> {
    const cols = await this.exec(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_name = ?${table.schema ? ' and table_schema = ?' : ''}
        order by ordinal_position`,
      table.schema ? [table.name, table.schema] : [table.name]
    )
    const pks = await this.primaryKeys(table).catch((): string[] => [])
    return {
      columns: cols.rows.map((c) => ({
        name: String(c[0]),
        type: String(c[1]),
        nullable: String(c[2]).toUpperCase() === 'YES',
        default: c[3] == null ? null : String(c[3]),
        isPrimaryKey: pks.includes(String(c[0]))
      })),
      foreignKeys: [],
      indexes: []
    }
  }

  async tableDDL(table: TableInfo): Promise<string> {
    const fqn = table.schema ? `${table.schema}.${table.name}` : table.name
    const res = await this.exec(`select get_ddl('table', ?)`, [fqn])
    return String(res.rows[0]?.[0] ?? '')
  }

  async erModel(): Promise<ErModel> {
    const cols = await this.exec(
      `select table_name, column_name from information_schema.columns
        where table_schema <> 'INFORMATION_SCHEMA' order by table_name, ordinal_position`
    )
    return buildErModel(
      cols.rows.map((r) => ({ t: String(r[0]), col: String(r[1]), isPk: false })),
      []
    )
  }

  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const cols = await this.exec(
      `select table_name, column_name, data_type, is_nullable from information_schema.columns
        where table_schema <> 'INFORMATION_SCHEMA' order by table_name, ordinal_position`
    )
    return buildSnapshot(
      cols.rows.map((r) => ({
        t: String(r[0]),
        col: String(r[1]),
        type: String(r[2]),
        nullable: String(r[3]).toUpperCase() === 'YES',
        isPk: false
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
        sql = `alter table ${t} alter column ${q(op.name)} set data type ${op.type}`
        break
      case 'setNullable':
        sql = `alter table ${t} alter column ${q(op.name)} ${op.nullable ? 'drop not null' : 'set not null'}`
        break
      default:
        throw new Error(`Snowflake does not support this change (${op.kind}).`)
    }
    await this.exec(sql)
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
    await this.exec(`create table ${ident} (${lines.join(', ')})`)
  }

  async dropTables(tables: TableInfo[], _opts: DropTableOptions): Promise<void> {
    for (const t of tables) await this.exec(`drop table if exists ${this.ident(t)}`)
  }

  async truncateTables(tables: TableInfo[], _opts: TruncateOptions): Promise<void> {
    for (const t of tables) await this.exec(`truncate table ${this.ident(t)}`)
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.exec('show databases')
    const idx = res.columns.findIndex((c) => c.name.toLowerCase() === 'name')
    return idx < 0 ? [] : res.rows.map((r) => String(r[idx]))
  }
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}
