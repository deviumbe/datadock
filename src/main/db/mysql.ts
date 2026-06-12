import mysql from 'mysql2/promise'
import type {
  AlterOp,
  ConnectionConfig,
  QueryResult,
  RowChangeSet,
  TableInfo,
  TableQueryOptions,
  TableStructure
} from '@shared/types'
import { DbAdapter, now, assertIdent } from './types'
import { buildClauses, groupIndexes, indexName } from './clauses'

const q = (ident: string): string => `\`${ident.replace(/`/g, '``')}\``

export class MySQLAdapter implements DbAdapter {
  private conn?: mysql.Connection
  constructor(public readonly config: ConnectionConfig) {}

  private connectOpts(): mysql.ConnectionOptions {
    return {
      host: this.config.host,
      port: this.config.port ?? 3306,
      database: this.config.database || undefined,
      user: this.config.user,
      password: this.config.password,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      dateStrings: true,
      connectTimeout: 10_000,
      multipleStatements: false
    }
  }

  async test(): Promise<void> {
    const conn = await mysql.createConnection(this.connectOpts())
    try {
      await conn.ping()
    } finally {
      await conn.end()
    }
  }

  async connect(): Promise<void> {
    this.conn = await mysql.createConnection(this.connectOpts())
  }

  async disconnect(): Promise<void> {
    await this.conn?.end()
    this.conn = undefined
  }

  async listTables(): Promise<TableInfo[]> {
    const [rows] = await this.conn!.query(
      `select table_name as name, table_type as type
         from information_schema.tables
        where table_schema = database()
        order by table_name`
    )
    return (rows as { name: string; type: string }[]).map((r) => ({
      name: r.name,
      type: r.type === 'VIEW' ? 'view' : 'table'
    }))
  }

  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const { where, order, params } = buildClauses(opts, q, () => '?')
    const sql = `select * from ${q(table.name)}${where}${order} limit ${opts.limit} offset ${opts.offset}`
    const start = now()
    const [rows, fields] = await this.conn!.query({ sql, values: params, rowsAsArray: true })
    const cols = Array.isArray(fields) ? fields.map((f) => ({ name: f.name })) : []
    return {
      columns: cols,
      rows: normalizeRows(rows as unknown[][]),
      rowCount: (rows as unknown[][]).length,
      durationMs: now() - start
    }
  }

  async primaryKeys(table: TableInfo): Promise<string[]> {
    const [rows] = await this.conn!.query(
      `select column_name as name from information_schema.key_column_usage
        where table_schema = database() and table_name = ? and constraint_name = 'PRIMARY'
        order by ordinal_position`,
      [table.name]
    )
    return (rows as { name: string }[]).map((r) => r.name)
  }

  async applyChanges(table: TableInfo, cs: RowChangeSet): Promise<number> {
    const conn = this.conn!
    const t = q(table.name)
    await conn.beginTransaction()
    try {
      let affected = 0

      for (const pk of cs.deletes) {
        const params: unknown[] = []
        const where = Object.keys(pk)
          .map((c) => {
            params.push(pk[c])
            return `${q(c)} = ?`
          })
          .join(' and ')
        const [res] = await conn.query(`delete from ${t} where ${where}`, params)
        affected += (res as mysql.ResultSetHeader).affectedRows ?? 0
      }

      for (const e of cs.updates) {
        const params: unknown[] = []
        const set = Object.keys(e.changes)
          .map((c) => {
            params.push(e.changes[c])
            return `${q(c)} = ?`
          })
          .join(', ')
        const where = Object.keys(e.pk)
          .map((c) => {
            params.push(e.pk[c])
            return `${q(c)} = ?`
          })
          .join(' and ')
        const [res] = await conn.query(`update ${t} set ${set} where ${where}`, params)
        affected += (res as mysql.ResultSetHeader).affectedRows ?? 0
      }

      for (const row of cs.inserts) {
        const cols = Object.keys(row)
        if (cols.length === 0) continue
        const params = cols.map((c) => row[c])
        await conn.query(
          `insert into ${t} (${cols.map(q).join(', ')}) values (${cols.map(() => '?').join(', ')})`,
          params
        )
        affected++
      }

      await conn.commit()
      return affected
    } catch (err) {
      await conn.rollback()
      throw err
    }
  }

  async query(sql: string): Promise<QueryResult> {
    const start = now()
    const [result, fields] = await this.conn!.query({ sql, rowsAsArray: true })
    const durationMs = now() - start

    // SELECT-like queries return an array of row-arrays plus field metadata.
    if (Array.isArray(fields) && fields.length > 0) {
      const rows = result as unknown[][]
      return {
        columns: fields.map((f) => ({ name: f.name })),
        rows: normalizeRows(rows),
        rowCount: rows.length,
        durationMs
      }
    }
    // INSERT/UPDATE/DELETE return an OkPacket.
    const ok = result as mysql.ResultSetHeader
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: ok?.affectedRows ?? 0,
      durationMs
    }
  }

  async schema(): Promise<Record<string, string[]>> {
    const [rows] = await this.conn!.query(
      `select table_name as t, column_name as c from information_schema.columns
        where table_schema = database() order by table_name, ordinal_position`
    )
    const map: Record<string, string[]> = {}
    for (const r of rows as { t: string; c: string }[]) (map[r.t] ??= []).push(r.c)
    return map
  }

  async tableDDL(table: TableInfo): Promise<string> {
    const [rows] = await this.conn!.query(`show create table ${q(table.name)}`)
    const row = (rows as Record<string, string>[])[0]
    return `${row['Create Table'] ?? row['Create View'] ?? ''};`
  }

  async tableStructure(table: TableInfo): Promise<TableStructure> {
    const [cols] = await this.conn!.query(
      `select column_name as name, column_type as type, is_nullable as nullable,
              column_default as \`default\`, column_key as col_key
         from information_schema.columns
        where table_schema = database() and table_name = ?
        order by ordinal_position`,
      [table.name]
    )
    const [fks] = await this.conn!.query(
      `select constraint_name as name, column_name as col,
              referenced_table_name as ref_table, referenced_column_name as ref_column
         from information_schema.key_column_usage
        where table_schema = database() and table_name = ? and referenced_table_name is not null`,
      [table.name]
    )
    const [idxRows] = await this.conn!.query(`show index from ${q(table.name)}`)
    const indexes = groupIndexes(
      (idxRows as Record<string, unknown>[])
        .filter((r) => r.Key_name !== 'PRIMARY')
        .sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index))
        .map((r) => ({
          name: String(r.Key_name),
          unique: Number(r.Non_unique) === 0,
          col: String(r.Column_name)
        }))
    )

    return {
      columns: (cols as Record<string, string>[]).map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable === 'YES',
        default: c.default ?? null,
        isPrimaryKey: c.col_key === 'PRI'
      })),
      foreignKeys: (fks as Record<string, string>[]).map((f) => ({
        name: f.name,
        column: f.col,
        refTable: f.ref_table,
        refColumn: f.ref_column
      })),
      indexes
    }
  }

  private async columnType(table: TableInfo, column: string): Promise<string> {
    const [rows] = await this.conn!.query(
      `select column_type as type, extra from information_schema.columns
        where table_schema = database() and table_name = ? and column_name = ?`,
      [table.name, column]
    )
    const r = (rows as { type: string; extra: string }[])[0]
    return r ? `${r.type}${r.extra ? ` ${r.extra}` : ''}` : 'text'
  }

  async alterTable(table: TableInfo, op: AlterOp): Promise<void> {
    const t = q(table.name)
    let sql: string
    switch (op.kind) {
      case 'addColumn':
        sql = `alter table ${t} add column ${q(assertIdent(op.name))} ${op.type}${op.nullable ? '' : ' not null'}${op.default ? ` default ${op.default}` : ''}`
        break
      case 'dropColumn':
        sql = `alter table ${t} drop column ${q(op.name)}`
        break
      case 'renameColumn':
        sql = `alter table ${t} rename column ${q(op.from)} to ${q(assertIdent(op.to))}`
        break
      case 'changeType':
        sql = `alter table ${t} modify column ${q(op.name)} ${op.type}`
        break
      case 'setNullable': {
        const type = await this.columnType(table, op.name)
        sql = `alter table ${t} modify column ${q(op.name)} ${type}${op.nullable ? ' null' : ' not null'}`
        break
      }
      case 'addForeignKey': {
        const name = op.name || `fk_${table.name}_${op.column}`
        sql = `alter table ${t} add constraint ${q(assertIdent(name))} foreign key (${q(op.column)}) references ${q(op.refTable)} (${q(op.refColumn)})${op.onDelete ? ` on delete ${op.onDelete}` : ''}`
        break
      }
      case 'dropForeignKey':
        sql = `alter table ${t} drop foreign key ${q(op.name)}`
        break
      case 'addIndex': {
        const name = op.name || indexName(table.name, op.columns)
        sql = `create ${op.unique ? 'unique ' : ''}index ${q(assertIdent(name))} on ${t} (${op.columns.map(q).join(', ')})`
        break
      }
      case 'dropIndex':
        sql = `alter table ${t} drop index ${q(op.name)}`
        break
    }
    await this.conn!.query(sql)
  }

  async listDatabases(): Promise<string[]> {
    const [rows] = await this.conn!.query('show databases')
    return (rows as Record<string, string>[]).map((r) => Object.values(r)[0])
  }

  async createDatabase(name: string): Promise<void> {
    await this.conn!.query(`create database \`${assertIdent(name)}\``)
  }

  async dropDatabase(name: string): Promise<void> {
    await this.conn!.query(`drop database \`${assertIdent(name)}\``)
  }

  async listProcesses(): Promise<QueryResult> {
    return this.query(
      `select id, user, host, db as \`database\`, command, time, state, left(info, 200) as info
         from information_schema.processlist order by time desc`
    )
  }

  async killProcess(id: string | number): Promise<void> {
    await this.conn!.query(`kill ${Number(id)}`)
  }

  async listUsers(): Promise<QueryResult> {
    return this.query('select user, host from mysql.user order by user, host')
  }
}

function normalizeRows(rows: unknown[][]): unknown[][] {
  return rows.map((row) => row.map(normalizeValue))
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}
