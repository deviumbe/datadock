import mysql from 'mysql2/promise'
import type {
  AlterOp,
  ConnectionConfig,
  CreateTableSpec,
  DropTableOptions,
  TruncateOptions,
  QueryResult,
  RowChangeSet,
  TableInfo,
  TableQueryOptions,
  TableSizeInfo,
  TableStructure
} from '@shared/types'
import { DbAdapter, now, toNum, assertIdent } from './types'
import { buildClauses, buildErModel, buildSnapshot, groupIndexes, indexName } from './clauses'
import type { ErModel, ReplicaLink, ReplicationStatus, SchemaSnapshot } from '@shared/types'

const q = (ident: string): string => `\`${ident.replace(/`/g, '``')}\``

export class MySQLAdapter implements DbAdapter {
  private conn?: mysql.Connection
  // Number of queries currently executing on the (serialized) connection.
  private inFlight = 0
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

  async beginTransaction(): Promise<void> {
    await this.conn!.beginTransaction()
  }
  async commitTransaction(): Promise<void> {
    await this.conn!.commit()
  }
  async rollbackTransaction(): Promise<void> {
    await this.conn!.rollback()
  }

  // Detected external cluster manager (memoized — it doesn't change per session).
  private managedByValue?: string | null
  private async detectManaged(): Promise<string | null> {
    if (this.managedByValue !== undefined) return this.managedByValue
    const count = async (sql: string): Promise<number> => {
      try {
        const [rows] = await this.conn!.query(sql)
        const r = (rows as Record<string, unknown>[])[0]
        return r ? Number(Object.values(r)[0]) : 0
      } catch {
        return 0
      }
    }
    let aurora = 0
    try {
      const [rows] = await this.conn!.query('select @@aurora_version as v')
      aurora = (rows as unknown[]).length ? 1 : 0
    } catch {
      aurora = 0
    }
    const rds = await count(
      `select count(*) as c from information_schema.routines
        where routine_schema = 'mysql' and routine_name like 'rds\\_%'`
    )
    const grp = await count('select count(*) as c from performance_schema.replication_group_members')
    this.managedByValue =
      aurora > 0 ? 'Amazon Aurora'
      : rds > 0 ? 'Amazon RDS'
      : grp > 0 ? 'MySQL Group Replication'
      : null
    return this.managedByValue
  }

  async replicationStatus(): Promise<ReplicationStatus> {
    // Run a SHOW that may not exist on this server version; treat errors as "no rows".
    const tryRows = async (sql: string): Promise<Record<string, unknown>[]> => {
      try {
        const [rows] = await this.conn!.query(sql)
        return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
      } catch {
        return []
      }
    }
    try {
      const managedBy = await this.detectManaged()
      // ---- replica side (8.0.22+ REPLICA wording, with legacy SLAVE fallback) ----
      let rep = await tryRows('SHOW REPLICA STATUS')
      if (!rep.length) rep = await tryRows('SHOW SLAVE STATUS')
      if (rep.length) {
        const r = rep[0]
        const lag = r.Seconds_Behind_Source ?? r.Seconds_Behind_Master
        const io = r.Replica_IO_Running ?? r.Slave_IO_Running
        const sql = r.Replica_SQL_Running ?? r.Slave_SQL_Running
        const host = r.Source_Host ?? r.Master_Host
        const file = r.Source_Log_File ?? r.Master_Log_File
        const pos = r.Read_Source_Log_Pos ?? r.Read_Master_Log_Pos
        const detail = [`Upstream ${host ?? '?'} · IO ${io ?? '?'} / SQL ${sql ?? '?'}`]
        // Seconds_Behind_* is NULL when a thread is stopped, and a deceptive 0 on idle.
        if (lag == null) detail.push('Seconds-behind is NULL — a replication thread is stopped')
        return {
          detectedRole: 'replica',
          isPrimary: false,
          lagSeconds: lag == null ? null : Number(lag),
          position: file ? `${file}:${pos ?? ''}` : undefined,
          detail,
          managedBy
        }
      }
      // ---- primary side: connected replicas + binlog position ----
      let hosts = await tryRows('SHOW REPLICAS')
      if (!hosts.length) hosts = await tryRows('SHOW SLAVE HOSTS')
      const replicas: ReplicaLink[] = hosts.map((h) => ({
        name: String(h.Host ?? h.Replica_UUID ?? h.Server_Id ?? 'replica'),
        lagSeconds: null
      }))
      let master = await tryRows('SHOW BINARY LOG STATUS')
      if (!master.length) master = await tryRows('SHOW MASTER STATUS')
      const m = master[0]
      const position = m ? `${m.File}:${m.Position}` : undefined
      return {
        detectedRole: replicas.length ? 'primary' : 'unknown',
        isPrimary: replicas.length > 0,
        replicas,
        position,
        detail: replicas.length
          ? undefined
          : ['No replica status and no connected replicas — standalone, or missing REPLICATION CLIENT privilege'],
        managedBy
      }
    } catch (err) {
      return {
        detectedRole: 'unknown',
        isPrimary: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
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

  async countRows(table: TableInfo, opts: TableQueryOptions): Promise<number> {
    const { where, params } = buildClauses(opts, q, () => '?')
    const [rows] = await this.conn!.query({
      sql: `select count(*) as cnt from ${q(table.name)}${where}`,
      values: params
    })
    return Number((rows as { cnt: number }[])[0]?.cnt ?? 0)
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
    this.inFlight++
    try {
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
    } finally {
      this.inFlight--
    }
  }

  async cancelQuery(): Promise<void> {
    const threadId = this.conn?.threadId
    if (!threadId || this.inFlight === 0) return
    // The connection is busy running the query, so KILL it from a fresh one.
    const killer = await mysql.createConnection(this.connectOpts())
    try {
      await killer.query(`KILL QUERY ${threadId}`)
    } finally {
      await killer.end()
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

  async erModel(): Promise<ErModel> {
    const [cols] = await this.conn!.query(
      `select table_name as t, column_name as col, (column_key = 'PRI') as is_pk
         from information_schema.columns where table_schema = database()
        order by table_name, ordinal_position`
    )
    const [rels] = await this.conn!.query(
      `select table_name as from_table, column_name as from_column,
              referenced_table_name as to_table, referenced_column_name as to_column
         from information_schema.key_column_usage
        where table_schema = database() and referenced_table_name is not null`
    )
    return buildErModel(
      (cols as Record<string, unknown>[]).map((r) => ({
        t: String(r.t),
        col: String(r.col),
        isPk: !!Number(r.is_pk)
      })),
      (rels as Record<string, unknown>[]).map((r) => ({
        fromTable: String(r.from_table),
        fromColumn: String(r.from_column),
        toTable: String(r.to_table),
        toColumn: String(r.to_column)
      }))
    )
  }

  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const [rows] = await this.conn!.query(
      `select table_name as t, column_name as col, column_type as type,
              is_nullable as nullable, (column_key = 'PRI') as is_pk
         from information_schema.columns where table_schema = database()
        order by table_name, ordinal_position`
    )
    return buildSnapshot(
      (rows as Record<string, unknown>[]).map((r) => ({
        t: String(r.t),
        col: String(r.col),
        type: String(r.type),
        nullable: r.nullable === 'YES',
        isPk: !!Number(r.is_pk)
      }))
    )
  }

  async tableSizes(): Promise<TableSizeInfo[]> {
    const res = await this.query(
      `select table_schema as \`schema\`, table_name as name,
              table_rows as \`rows\`,
              (data_length + index_length) as bytes
         from information_schema.tables
        where table_schema = database() and table_type = 'BASE TABLE'
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

  async createTable(spec: CreateTableSpec): Promise<void> {
    const lines = spec.columns.map((c) => {
      let l = `${q(assertIdent(c.name))} ${c.type}`
      if (!c.nullable) l += ' not null'
      if (c.default) l += ` default ${c.default}`
      return l
    })
    const pks = spec.columns.filter((c) => c.primaryKey).map((c) => q(c.name))
    if (pks.length) lines.push(`primary key (${pks.join(', ')})`)
    await this.conn!.query(`create table ${q(assertIdent(spec.name))} (${lines.join(', ')})`)
  }

  async dropTables(tables: TableInfo[], opts: DropTableOptions): Promise<void> {
    const off = !!(opts.ignoreForeignKeys || opts.cascade)
    if (off) await this.conn!.query('set foreign_key_checks = 0')
    try {
      for (const t of tables) await this.conn!.query(`drop table if exists ${q(t.name)}`)
    } finally {
      if (off) await this.conn!.query('set foreign_key_checks = 1')
    }
  }

  async truncateTables(tables: TableInfo[], opts: TruncateOptions): Promise<void> {
    // TRUNCATE always resets AUTO_INCREMENT, so restartIdentity needs no extra work.
    const off = !!opts.ignoreForeignKeys
    if (off) await this.conn!.query('set foreign_key_checks = 0')
    try {
      for (const t of tables) await this.conn!.query(`truncate table ${q(t.name)}`)
    } finally {
      if (off) await this.conn!.query('set foreign_key_checks = 1')
    }
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
