import sql from 'mssql'
import type {
  AlterOp,
  ConnectionConfig,
  CreateTableSpec,
  DropTableOptions,
  QueryResult,
  RowChangeSet,
  TableInfo,
  TableQueryOptions,
  TableSizeInfo,
  TableStructure
} from '@shared/types'
import { DbAdapter, now, toNum, assertIdent } from './types'
import { buildClauses, buildErModel, buildSnapshot, groupIndexes, indexName } from './clauses'
import type { ErModel, SchemaSnapshot } from '@shared/types'

const q = (ident: string): string => `[${ident.replace(/]/g, ']]')}]`

export class MSSQLAdapter implements DbAdapter {
  private pool?: sql.ConnectionPool
  private txn?: sql.Transaction

  async beginTransaction(): Promise<void> {
    this.txn = new sql.Transaction(this.pool)
    await this.txn.begin()
  }
  async commitTransaction(): Promise<void> {
    if (!this.txn) return
    await this.txn.commit()
    this.txn = undefined
  }
  async rollbackTransaction(): Promise<void> {
    if (!this.txn) return
    await this.txn.rollback()
    this.txn = undefined
  }

  private request(): sql.Request {
    return this.txn ? new sql.Request(this.txn) : this.pool!.request()
  }
  constructor(public readonly config: ConnectionConfig) {}

  private poolConfig(): sql.config {
    return {
      server: this.config.host ?? 'localhost',
      port: this.config.port ?? 1433,
      database: this.config.database || undefined,
      user: this.config.user,
      password: this.config.password,
      options: {
        encrypt: !!this.config.ssl,
        trustServerCertificate: true
      },
      pool: { max: 4, min: 0 },
      connectionTimeout: 10_000,
      requestTimeout: 30_000
    }
  }

  async test(): Promise<void> {
    const pool = new sql.ConnectionPool(this.poolConfig())
    try {
      await pool.connect()
    } finally {
      await pool.close()
    }
  }

  async connect(): Promise<void> {
    this.pool = await new sql.ConnectionPool(this.poolConfig()).connect()
  }

  async disconnect(): Promise<void> {
    if (this.txn) {
      try {
        await this.txn.rollback()
      } catch {
        /* ignore */
      }
      this.txn = undefined
    }
    await this.pool?.close()
    this.pool = undefined
  }

  async listTables(): Promise<TableInfo[]> {
    const res = await this.pool!.request().query(
      `select table_schema as [schema], table_name as name, table_type as type
         from information_schema.tables
        order by table_schema, table_name`
    )
    return res.recordset.map((r) => ({
      schema: r.schema as string,
      name: r.name as string,
      type: r.type === 'VIEW' ? 'view' : 'table'
    }))
  }

  async erModel(): Promise<ErModel> {
    const cols = await this.pool!.request().query(
      `select c.table_name as t, c.column_name as col,
              case when pk.column_name is not null then 1 else 0 end as is_pk
         from information_schema.columns c
         left join (
           select kcu.table_name, kcu.column_name
             from information_schema.table_constraints tc
             join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
            where tc.constraint_type = 'PRIMARY KEY'
         ) pk on pk.table_name = c.table_name and pk.column_name = c.column_name
        order by c.table_name, c.ordinal_position`
    )
    const rels = await this.pool!.request().query(
      `select tc.table_name as from_table, kcu.column_name as from_column,
              ccu.table_name as to_table, ccu.column_name as to_column
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
         join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
        where tc.constraint_type = 'FOREIGN KEY'`
    )
    return buildErModel(
      cols.recordset.map((r) => ({ t: r.t as string, col: r.col as string, isPk: !!r.is_pk })),
      rels.recordset.map((r) => ({
        fromTable: r.from_table as string,
        fromColumn: r.from_column as string,
        toTable: r.to_table as string,
        toColumn: r.to_column as string
      }))
    )
  }

  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const res = await this.pool!.request().query(
      `select c.table_name as t, c.column_name as col, c.data_type as dtype,
              c.character_maximum_length as len, c.is_nullable as nullable,
              case when pk.column_name is not null then 1 else 0 end as is_pk
         from information_schema.columns c
         left join (
           select kcu.table_name, kcu.column_name
             from information_schema.table_constraints tc
             join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
            where tc.constraint_type = 'PRIMARY KEY'
         ) pk on pk.table_name = c.table_name and pk.column_name = c.column_name
        order by c.table_name, c.ordinal_position`
    )
    return buildSnapshot(
      res.recordset.map((r) => {
        const len = r.len as number | null
        let type = r.dtype as string
        if (len && len > 0) type += `(${len})`
        else if (len === -1) type += '(max)'
        return {
          t: r.t as string,
          col: r.col as string,
          type,
          nullable: r.nullable === 'YES',
          isPk: !!r.is_pk
        }
      })
    )
  }

  async schema(): Promise<Record<string, string[]>> {
    const res = await this.pool!.request().query(
      `select table_name as t, column_name as c from information_schema.columns
        order by table_name, ordinal_position`
    )
    const map: Record<string, string[]> = {}
    for (const r of res.recordset) (map[r.t as string] ??= []).push(r.c as string)
    return map
  }

  private ident(table: TableInfo): string {
    return `${q(table.schema ?? 'dbo')}.${q(table.name)}`
  }

  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const { where, order, params } = buildClauses(opts, q, (i) => `@p${i - 1}`)
    // OFFSET/FETCH requires an ORDER BY.
    const orderSql = order || ' order by (select null)'
    const req = this.pool!.request()
    params.forEach((v, i) => req.input(`p${i}`, v))
    const sqlText = `select * from ${this.ident(table)}${where}${orderSql} offset ${opts.offset} rows fetch next ${opts.limit} rows only`
    const start = now()
    const res = await req.query(sqlText)
    return this.shape(res, now() - start)
  }

  private shape(res: sql.IResult<Record<string, unknown>>, durationMs: number): QueryResult {
    const recordset = res.recordset
    if (recordset && recordset.columns) {
      const cols = Object.entries(recordset.columns)
        .sort((a, b) => (a[1].index ?? 0) - (b[1].index ?? 0))
        .map(([name]) => name)
      const rows = recordset.map((row) => cols.map((c) => normalizeValue(row[c])))
      return { columns: cols.map((name) => ({ name })), rows, rowCount: rows.length, durationMs }
    }
    return { columns: [], rows: [], rowCount: 0, affectedRows: res.rowsAffected?.[0] ?? 0, durationMs }
  }

  async primaryKeys(table: TableInfo): Promise<string[]> {
    const req = this.pool!.request()
    req.input('t', table.name)
    req.input('s', table.schema ?? 'dbo')
    const res = await req.query(
      `select kcu.column_name as name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
        where tc.constraint_type = 'PRIMARY KEY' and tc.table_name = @t and tc.table_schema = @s
        order by kcu.ordinal_position`
    )
    return res.recordset.map((r) => r.name as string)
  }

  async applyChanges(table: TableInfo, cs: RowChangeSet): Promise<number> {
    const tx = new sql.Transaction(this.pool)
    const t = this.ident(table)
    await tx.begin()
    try {
      let affected = 0

      for (const pk of cs.deletes) {
        const req = new sql.Request(tx)
        let i = 0
        const where = Object.keys(pk)
          .map((c) => {
            const p = `w${i++}`
            req.input(p, pk[c])
            return `${q(c)} = @${p}`
          })
          .join(' and ')
        const r = await req.query(`delete from ${t} where ${where}`)
        affected += r.rowsAffected?.[0] ?? 0
      }

      for (const e of cs.updates) {
        const req = new sql.Request(tx)
        let i = 0
        const set = Object.keys(e.changes)
          .map((c) => {
            const p = `s${i++}`
            req.input(p, e.changes[c])
            return `${q(c)} = @${p}`
          })
          .join(', ')
        const where = Object.keys(e.pk)
          .map((c) => {
            const p = `w${i++}`
            req.input(p, e.pk[c])
            return `${q(c)} = @${p}`
          })
          .join(' and ')
        const r = await req.query(`update ${t} set ${set} where ${where}`)
        affected += r.rowsAffected?.[0] ?? 0
      }

      for (const row of cs.inserts) {
        const cols = Object.keys(row)
        if (cols.length === 0) continue
        const req = new sql.Request(tx)
        const names = cols.map((c, i) => {
          req.input(`v${i}`, row[c])
          return q(c)
        })
        const placeholders = cols.map((_, i) => `@v${i}`)
        await req.query(`insert into ${t} (${names.join(', ')}) values (${placeholders.join(', ')})`)
        affected++
      }

      await tx.commit()
      return affected
    } catch (err) {
      await tx.rollback()
      throw err
    }
  }

  async query(sqlText: string): Promise<QueryResult> {
    const start = now()
    const res = await this.request().query(sqlText)
    return this.shape(res, now() - start)
  }

  async tableSizes(): Promise<TableSizeInfo[]> {
    const res = await this.query(
      `select s.name as [schema], t.name as name,
              sum(case when p.index_id in (0, 1) then p.rows else 0 end) as [rows],
              sum(a.total_pages) * 8 * 1024 as bytes
         from sys.tables t
         join sys.schemas s on s.schema_id = t.schema_id
         join sys.partitions p on p.object_id = t.object_id
         join sys.allocation_units a on a.container_id = p.partition_id
        group by s.name, t.name
        order by bytes desc`
    )
    return res.rows.map((r) => ({
      schema: r[0] == null ? undefined : String(r[0]),
      name: String(r[1]),
      rows: toNum(r[2]),
      bytes: toNum(r[3])
    }))
  }

  async tableDDL(table: TableInfo): Promise<string> {
    const schema = table.schema ?? 'dbo'
    const req = this.pool!.request()
    req.input('s', schema)
    req.input('t', table.name)
    const cols = await req.query(
      `select column_name, data_type, character_maximum_length, is_nullable, column_default
         from information_schema.columns
        where table_schema = @s and table_name = @t
        order by ordinal_position`
    )
    const pks = await this.primaryKeys(table)
    const lines = cols.recordset.map((c) => {
      let type = c.data_type as string
      const len = c.character_maximum_length as number | null
      if (len && len > 0) type += `(${len})`
      else if (len === -1) type += '(max)'
      let line = `  ${q(c.column_name)} ${type}`
      if (c.is_nullable === 'NO') line += ' not null'
      if (c.column_default) line += ` default ${c.column_default}`
      return line
    })
    if (pks.length) lines.push(`  primary key (${pks.map(q).join(', ')})`)
    return `create table ${this.ident(table)} (\n${lines.join(',\n')}\n);`
  }

  async tableStructure(table: TableInfo): Promise<TableStructure> {
    const schema = table.schema ?? 'dbo'
    const req = this.pool!.request()
    req.input('s', schema)
    req.input('t', table.name)
    const cols = await req.query(
      `select column_name, data_type, character_maximum_length, is_nullable, column_default
         from information_schema.columns
        where table_schema = @s and table_name = @t
        order by ordinal_position`
    )
    const pks = await this.primaryKeys(table)
    const fkReq = this.pool!.request()
    fkReq.input('s', schema)
    fkReq.input('t', table.name)
    const fks = await fkReq.query(
      `select tc.constraint_name as name, kcu.column_name as [column],
              ccu.table_name as ref_table, ccu.column_name as ref_column
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name
        where tc.constraint_type = 'FOREIGN KEY' and tc.table_name = @t and tc.table_schema = @s`
    )
    const idxReq = this.pool!.request()
    idxReq.input('full', `${schema}.${table.name}`)
    const idx = await idxReq.query(
      `select i.name as name, i.is_unique as is_unique, c.name as col, ic.key_ordinal as ord
         from sys.indexes i
         join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
         join sys.columns c on c.object_id = i.object_id and c.column_id = ic.column_id
        where i.object_id = object_id(@full) and i.is_primary_key = 0 and i.type > 0
        order by i.name, ic.key_ordinal`
    )

    return {
      columns: cols.recordset.map((c) => {
        const len = c.character_maximum_length as number | null
        let type = c.data_type as string
        if (len && len > 0) type += `(${len})`
        else if (len === -1) type += '(max)'
        return {
          name: c.column_name as string,
          type,
          nullable: c.is_nullable === 'YES',
          default: (c.column_default as string) ?? null,
          isPrimaryKey: pks.includes(c.column_name)
        }
      }),
      foreignKeys: fks.recordset.map((f) => ({
        name: f.name as string,
        column: f.column as string,
        refTable: f.ref_table as string,
        refColumn: f.ref_column as string
      })),
      indexes: groupIndexes(
        idx.recordset.map((r) => ({ name: r.name as string, unique: !!r.is_unique, col: r.col as string }))
      )
    }
  }

  private async columnType(table: TableInfo, column: string): Promise<string> {
    const req = this.pool!.request()
    req.input('s', table.schema ?? 'dbo')
    req.input('t', table.name)
    req.input('c', column)
    const res = await req.query(
      `select data_type, character_maximum_length as len from information_schema.columns
        where table_schema = @s and table_name = @t and column_name = @c`
    )
    const r = res.recordset[0]
    if (!r) return 'varchar(max)'
    let type = r.data_type as string
    if (r.len && r.len > 0) type += `(${r.len})`
    else if (r.len === -1) type += '(max)'
    return type
  }

  async alterTable(table: TableInfo, op: AlterOp): Promise<void> {
    const t = this.ident(table)
    const req = this.pool!.request()
    let sql: string
    switch (op.kind) {
      case 'addColumn':
        sql = `alter table ${t} add ${q(assertIdent(op.name))} ${op.type}${op.nullable ? ' null' : ' not null'}${op.default ? ` default ${op.default}` : ''}`
        break
      case 'dropColumn':
        sql = `alter table ${t} drop column ${q(op.name)}`
        break
      case 'renameColumn': {
        assertIdent(op.to)
        req.input('o', `${table.schema ?? 'dbo'}.${table.name}.${op.from}`)
        req.input('n', op.to)
        await req.query(`exec sp_rename @o, @n, 'COLUMN'`)
        return
      }
      case 'changeType':
        sql = `alter table ${t} alter column ${q(op.name)} ${op.type}`
        break
      case 'setNullable': {
        const type = await this.columnType(table, op.name)
        sql = `alter table ${t} alter column ${q(op.name)} ${type} ${op.nullable ? 'null' : 'not null'}`
        break
      }
      case 'addForeignKey': {
        const name = op.name || `fk_${table.name}_${op.column}`
        sql = `alter table ${t} add constraint ${q(assertIdent(name))} foreign key (${q(op.column)}) references ${q(op.refTable)} (${q(op.refColumn)})${op.onDelete ? ` on delete ${op.onDelete}` : ''}`
        break
      }
      case 'dropForeignKey':
        sql = `alter table ${t} drop constraint ${q(op.name)}`
        break
      case 'addIndex': {
        const name = op.name || indexName(table.name, op.columns)
        sql = `create ${op.unique ? 'unique ' : ''}index ${q(assertIdent(name))} on ${t} (${op.columns.map(q).join(', ')})`
        break
      }
      case 'dropIndex':
        sql = `drop index ${q(op.name)} on ${t}`
        break
    }
    await req.query(sql)
  }

  async createTable(spec: CreateTableSpec): Promise<void> {
    const ident = `${q(spec.schema ?? 'dbo')}.${q(assertIdent(spec.name))}`
    const lines = spec.columns.map((c) => {
      let l = `${q(assertIdent(c.name))} ${c.type}`
      l += c.nullable ? ' null' : ' not null'
      if (c.default) l += ` default ${c.default}`
      return l
    })
    const pks = spec.columns.filter((c) => c.primaryKey).map((c) => q(c.name))
    if (pks.length) lines.push(`primary key (${pks.join(', ')})`)
    await this.pool!.request().query(`create table ${ident} (${lines.join(', ')})`)
  }

  async dropTables(tables: TableInfo[], _opts: DropTableOptions): Promise<void> {
    // SQL Server has no global FK toggle or CASCADE for DROP TABLE; if a table
    // is referenced by a foreign key the drop will error (the caller is warned).
    for (const t of tables) await this.pool!.request().query(`drop table if exists ${this.ident(t)}`)
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.pool!.request().query('select name from sys.databases order by name')
    return res.recordset.map((r) => r.name as string)
  }

  async createDatabase(name: string): Promise<void> {
    await this.pool!.request().query(`create database [${assertIdent(name)}]`)
  }

  async dropDatabase(name: string): Promise<void> {
    await this.pool!.request().query(`drop database [${assertIdent(name)}]`)
  }

  async listProcesses(): Promise<QueryResult> {
    return this.query(
      `select s.session_id, s.login_name as [user], s.host_name as host,
              db_name(s.database_id) as [database], s.status,
              r.command, r.cpu_time, substring(t.text, 1, 200) as query
         from sys.dm_exec_sessions s
         left join sys.dm_exec_requests r on r.session_id = s.session_id
         outer apply sys.dm_exec_sql_text(r.sql_handle) t
        where s.is_user_process = 1
        order by s.session_id`
    )
  }

  async killProcess(id: string | number): Promise<void> {
    await this.pool!.request().query(`kill ${Number(id)}`)
  }

  async listUsers(): Promise<QueryResult> {
    return this.query(
      `select name, type_desc, is_disabled, create_date
         from sys.server_principals
        where type in ('S', 'U', 'G') order by name`
    )
  }
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}
