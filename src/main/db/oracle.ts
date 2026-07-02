import oracledb from 'oracledb'
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
import { buildClauses, buildErModel, buildSnapshot, groupIndexes, indexName } from './clauses'

// Fetch large/long types as plain JS values rather than Lob/stream objects.
oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB]
oracledb.fetchAsBuffer = [oracledb.BLOB]

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`

export class OracleAdapter implements DbAdapter {
  private pool?: oracledb.Pool
  /** Default schema (owner), uppercased — Oracle folds unquoted identifiers. */
  private owner = ''
  /** Dedicated connection held while an explicit transaction is open. */
  private txnConn?: oracledb.Connection

  constructor(public readonly config: ConnectionConfig) {}

  private connectString(): string {
    const host = this.config.host ?? 'localhost'
    const port = this.config.port ?? 1521
    return this.config.database ? `${host}:${port}/${this.config.database}` : `${host}:${port}`
  }

  async test(): Promise<void> {
    const conn = await oracledb.getConnection({
      user: this.config.user,
      password: this.config.password,
      connectString: this.connectString()
    })
    await conn.close()
  }

  async connect(): Promise<void> {
    this.pool = await oracledb.createPool({
      user: this.config.user,
      password: this.config.password,
      connectString: this.connectString(),
      poolMin: 0,
      poolMax: 4,
      poolTimeout: 60
    })
    const r = await this.exec(`select sys_context('USERENV', 'CURRENT_SCHEMA') from dual`)
    this.owner = String(r.rows?.[0]?.[0] ?? this.config.user ?? '').toUpperCase()
  }

  async disconnect(): Promise<void> {
    if (this.txnConn) {
      try {
        await this.txnConn.rollback()
        await this.txnConn.close()
      } catch {
        /* ignore */
      }
      this.txnConn = undefined
    }
    await this.pool?.close(0).catch(() => undefined)
    this.pool = undefined
  }

  // ---- transactions ---------------------------------------------------------
  async beginTransaction(): Promise<void> {
    this.txnConn = await this.pool!.getConnection()
  }
  async commitTransaction(): Promise<void> {
    if (!this.txnConn) return
    await this.txnConn.commit()
    await this.txnConn.close()
    this.txnConn = undefined
  }
  async rollbackTransaction(): Promise<void> {
    if (!this.txnConn) return
    await this.txnConn.rollback()
    await this.txnConn.close()
    this.txnConn = undefined
  }

  /** Run a statement on the txn connection (if open) or a pooled one. */
  private async exec(
    sql: string,
    binds: oracledb.BindParameters = [],
    extra: oracledb.ExecuteOptions = {}
  ): Promise<oracledb.Result<unknown[]>> {
    const inTxn = !!this.txnConn
    const opts: oracledb.ExecuteOptions = {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      autoCommit: !inTxn,
      ...extra
    }
    if (inTxn) return this.txnConn!.execute(sql, binds, opts) as Promise<oracledb.Result<unknown[]>>
    const conn = await this.pool!.getConnection()
    try {
      return (await conn.execute(sql, binds, opts)) as oracledb.Result<unknown[]>
    } finally {
      await conn.close()
    }
  }

  private shape(res: oracledb.Result<unknown[]>, durationMs: number): QueryResult {
    if (res.metaData && res.metaData.length) {
      const columns = res.metaData.map((m) => ({ name: m.name }))
      const rows = (res.rows ?? []).map((r) => (r as unknown[]).map(normalizeValue))
      return { columns, rows, rowCount: rows.length, durationMs }
    }
    return { columns: [], rows: [], rowCount: 0, affectedRows: res.rowsAffected ?? 0, durationMs }
  }

  async query(sqlText: string): Promise<QueryResult> {
    const start = now()
    const res = await this.exec(sqlText.replace(/;\s*$/, ''))
    return this.shape(res, now() - start)
  }

  private ident(table: TableInfo): string {
    return `${q(table.schema ?? this.owner)}.${q(table.name)}`
  }

  async listTables(): Promise<TableInfo[]> {
    const res = await this.exec(
      `select object_name, object_type from all_objects
        where owner = :owner and object_type in ('TABLE', 'VIEW')
          and object_name not like 'BIN$%'
        order by object_name`,
      { owner: this.owner }
    )
    return (res.rows ?? []).map((r) => ({
      schema: this.owner,
      name: String((r as unknown[])[0]),
      type: (r as unknown[])[1] === 'VIEW' ? 'view' : 'table'
    }))
  }

  async primaryKeys(table: TableInfo): Promise<string[]> {
    const res = await this.exec(
      `select cc.column_name from all_constraints c
         join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name
        where c.constraint_type = 'P' and c.owner = :owner and c.table_name = :t
        order by cc.position`,
      { owner: table.schema ?? this.owner, t: table.name }
    )
    return (res.rows ?? []).map((r) => String((r as unknown[])[0]))
  }

  async schema(): Promise<Record<string, string[]>> {
    const res = await this.exec(
      `select table_name, column_name from all_tab_columns
        where owner = :owner order by table_name, column_id`,
      { owner: this.owner }
    )
    const map: Record<string, string[]> = {}
    for (const r of res.rows ?? []) {
      const [t, c] = r as unknown[]
      ;(map[String(t)] ??= []).push(String(c))
    }
    return map
  }

  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const { where, order, params } = buildClauses(opts, q, (i) => `:${i}`)
    const sqlText =
      `select * from ${this.ident(table)}${where}${order}` +
      ` offset ${Number(opts.offset)} rows fetch next ${Number(opts.limit)} rows only`
    const start = now()
    const res = await this.exec(sqlText, params as oracledb.BindParameters)
    return this.shape(res, now() - start)
  }

  async countRows(table: TableInfo, opts: TableQueryOptions): Promise<number> {
    const { where, params } = buildClauses(opts, q, (i) => `:${i}`)
    const res = await this.exec(
      `select count(*) from ${this.ident(table)}${where}`,
      params as oracledb.BindParameters
    )
    return Number((res.rows?.[0] as unknown[])?.[0] ?? 0)
  }

  async applyChanges(table: TableInfo, cs: RowChangeSet): Promise<number> {
    const t = this.ident(table)
    const conn = await this.pool!.getConnection()
    try {
      let affected = 0
      for (const pk of cs.deletes) {
        const binds: Record<string, unknown> = {}
        let i = 0
        const where = Object.keys(pk)
          .map((c) => {
            const k = `w${i++}`
            binds[k] = pk[c]
            return `${q(c)} = :${k}`
          })
          .join(' and ')
        const r = await conn.execute(`delete from ${t} where ${where}`, binds as oracledb.BindParameters)
        affected += r.rowsAffected ?? 0
      }
      for (const e of cs.updates) {
        const binds: Record<string, unknown> = {}
        let i = 0
        const set = Object.keys(e.changes)
          .map((c) => {
            const k = `s${i++}`
            binds[k] = e.changes[c]
            return `${q(c)} = :${k}`
          })
          .join(', ')
        const where = Object.keys(e.pk)
          .map((c) => {
            const k = `w${i++}`
            binds[k] = e.pk[c]
            return `${q(c)} = :${k}`
          })
          .join(' and ')
        const r = await conn.execute(`update ${t} set ${set} where ${where}`, binds as oracledb.BindParameters)
        affected += r.rowsAffected ?? 0
      }
      for (const row of cs.inserts) {
        const cols = Object.keys(row)
        if (!cols.length) continue
        const binds: Record<string, unknown> = {}
        const names = cols.map((c, i) => {
          binds[`v${i}`] = row[c]
          return q(c)
        })
        const ph = cols.map((_, i) => `:v${i}`)
        await conn.execute(`insert into ${t} (${names.join(', ')}) values (${ph.join(', ')})`, binds as oracledb.BindParameters)
        affected++
      }
      await conn.commit()
      return affected
    } catch (err) {
      await conn.rollback().catch(() => undefined)
      throw err
    } finally {
      await conn.close()
    }
  }

  async tableSizes(): Promise<TableSizeInfo[]> {
    const res = await this.exec(
      `select t.table_name, t.num_rows, s.bytes
         from all_tables t
         left join user_segments s
           on s.segment_name = t.table_name and s.segment_type = 'TABLE'
        where t.owner = :owner
        order by s.bytes desc nulls last`,
      { owner: this.owner }
    )
    return (res.rows ?? []).map((r) => {
      const row = r as unknown[]
      return { schema: this.owner, name: String(row[0]), rows: toNum(row[1]), bytes: toNum(row[2]) }
    })
  }

  async tableDDL(table: TableInfo): Promise<string> {
    const res = await this.exec(
      `select dbms_metadata.get_ddl('TABLE', :t, :owner) from dual`,
      { t: table.name, owner: table.schema ?? this.owner }
    )
    const ddl = (res.rows?.[0] as unknown[])?.[0]
    return ddl ? `${String(ddl).trim()};` : ''
  }

  async tableStructure(table: TableInfo): Promise<TableStructure> {
    const owner = table.schema ?? this.owner
    const colsRes = await this.exec(
      `select column_name, data_type, data_length, data_precision, data_scale, nullable, char_used
         from all_tab_columns where owner = :owner and table_name = :t
        order by column_id`,
      { owner, t: table.name }
    )
    const pks = await this.primaryKeys(table)
    const fksRes = await this.exec(
      `select ac.constraint_name, acc.column_name, rac.table_name, racc.column_name
         from all_constraints ac
         join all_cons_columns acc on acc.owner = ac.owner and acc.constraint_name = ac.constraint_name
         join all_constraints rac on rac.owner = ac.r_owner and rac.constraint_name = ac.r_constraint_name
         join all_cons_columns racc on racc.owner = rac.owner and racc.constraint_name = rac.constraint_name and racc.position = acc.position
        where ac.constraint_type = 'R' and ac.owner = :owner and ac.table_name = :t`,
      { owner, t: table.name }
    )
    const idxRes = await this.exec(
      `select i.index_name, i.uniqueness, ic.column_name, ic.column_position
         from all_indexes i
         join all_ind_columns ic on ic.index_owner = i.owner and ic.index_name = i.index_name
        where i.table_owner = :owner and i.table_name = :t
          and i.index_name not in (
            select constraint_name from all_constraints
             where owner = :owner and table_name = :t and constraint_type = 'P'
          )
        order by i.index_name, ic.column_position`,
      { owner, t: table.name }
    )

    return {
      columns: (colsRes.rows ?? []).map((r) => {
        const [name, dtype, len, prec, scale, nullable] = r as unknown[]
        return {
          name: String(name),
          type: oracleType(String(dtype), toNum(len), toNum(prec), toNum(scale)),
          nullable: nullable === 'Y',
          default: null, // data_default is a LONG column — skipped to keep reads simple
          isPrimaryKey: pks.includes(String(name))
        }
      }),
      foreignKeys: (fksRes.rows ?? []).map((r) => {
        const row = r as unknown[]
        return {
          name: String(row[0]),
          column: String(row[1]),
          refTable: String(row[2]),
          refColumn: String(row[3])
        }
      }),
      indexes: groupIndexes(
        (idxRes.rows ?? []).map((r) => {
          const row = r as unknown[]
          return { name: String(row[0]), unique: row[1] === 'UNIQUE', col: String(row[2]) }
        })
      )
    }
  }

  async erModel(): Promise<ErModel> {
    const colsRes = await this.exec(
      `select c.table_name, c.column_name,
              case when p.col is not null then 1 else 0 end is_pk
         from all_tab_columns c
         left join (
           select cc.table_name tbl, cc.column_name col
             from all_constraints ac
             join all_cons_columns cc on cc.owner = ac.owner and cc.constraint_name = ac.constraint_name
            where ac.constraint_type = 'P' and ac.owner = :owner
         ) p on p.tbl = c.table_name and p.col = c.column_name
        where c.owner = :owner
        order by c.table_name, c.column_id`,
      { owner: this.owner }
    )
    const relsRes = await this.exec(
      `select ac.table_name, acc.column_name, rac.table_name, racc.column_name
         from all_constraints ac
         join all_cons_columns acc on acc.owner = ac.owner and acc.constraint_name = ac.constraint_name
         join all_constraints rac on rac.owner = ac.r_owner and rac.constraint_name = ac.r_constraint_name
         join all_cons_columns racc on racc.owner = rac.owner and racc.constraint_name = rac.constraint_name and racc.position = acc.position
        where ac.constraint_type = 'R' and ac.owner = :owner`,
      { owner: this.owner }
    )
    return buildErModel(
      (colsRes.rows ?? []).map((r) => {
        const row = r as unknown[]
        return { t: String(row[0]), col: String(row[1]), isPk: row[2] === 1 }
      }),
      (relsRes.rows ?? []).map((r) => {
        const row = r as unknown[]
        return {
          fromTable: String(row[0]),
          fromColumn: String(row[1]),
          toTable: String(row[2]),
          toColumn: String(row[3])
        }
      })
    )
  }

  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const res = await this.exec(
      `select c.table_name, c.column_name, c.data_type, c.data_length, c.data_precision,
              c.data_scale, c.nullable,
              case when p.col is not null then 1 else 0 end is_pk
         from all_tab_columns c
         left join (
           select cc.table_name tbl, cc.column_name col
             from all_constraints ac
             join all_cons_columns cc on cc.owner = ac.owner and cc.constraint_name = ac.constraint_name
            where ac.constraint_type = 'P' and ac.owner = :owner
         ) p on p.tbl = c.table_name and p.col = c.column_name
        where c.owner = :owner
        order by c.table_name, c.column_id`,
      { owner: this.owner }
    )
    return buildSnapshot(
      (res.rows ?? []).map((r) => {
        const [t, col, dtype, len, prec, scale, nullable, isPk] = r as unknown[]
        return {
          t: String(t),
          col: String(col),
          type: oracleType(String(dtype), toNum(len), toNum(prec), toNum(scale)),
          nullable: nullable === 'Y',
          isPk: isPk === 1
        }
      })
    )
  }

  async alterTable(table: TableInfo, op: AlterOp): Promise<void> {
    const t = this.ident(table)
    let sql: string
    switch (op.kind) {
      case 'addColumn':
        sql = `alter table ${t} add (${q(assertIdent(op.name))} ${op.type}${op.default ? ` default ${op.default}` : ''}${op.nullable ? '' : ' not null'})`
        break
      case 'dropColumn':
        sql = `alter table ${t} drop column ${q(op.name)}`
        break
      case 'renameColumn':
        sql = `alter table ${t} rename column ${q(op.from)} to ${q(assertIdent(op.to))}`
        break
      case 'changeType':
        sql = `alter table ${t} modify (${q(op.name)} ${op.type})`
        break
      case 'setNullable': {
        // Oracle errors if you re-declare the same nullability; modify just the clause.
        sql = `alter table ${t} modify (${q(op.name)} ${op.nullable ? 'null' : 'not null'})`
        break
      }
      case 'addForeignKey': {
        const name = op.name || `FK_${table.name}_${op.column}`
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
        sql = `drop index ${q(op.name)}`
        break
    }
    await this.exec(sql)
  }

  async createTable(spec: CreateTableSpec): Promise<void> {
    const ident = `${q(spec.schema ?? this.owner)}.${q(assertIdent(spec.name))}`
    const lines = spec.columns.map((c) => {
      let l = `${q(assertIdent(c.name))} ${c.type}`
      if (c.default) l += ` default ${c.default}`
      if (!c.nullable) l += ' not null'
      return l
    })
    const pks = spec.columns.filter((c) => c.primaryKey).map((c) => q(c.name))
    if (pks.length) lines.push(`primary key (${pks.join(', ')})`)
    await this.exec(`create table ${ident} (${lines.join(', ')})`)
  }

  async dropTables(tables: TableInfo[], opts: DropTableOptions): Promise<void> {
    const cascade = opts.cascade || opts.ignoreForeignKeys ? ' cascade constraints' : ''
    for (const t of tables) await this.exec(`drop table ${this.ident(t)}${cascade}`)
  }

  async truncateTables(tables: TableInfo[], _opts: TruncateOptions): Promise<void> {
    for (const t of tables) await this.exec(`truncate table ${this.ident(t)}`)
  }

  async listUsers(): Promise<QueryResult> {
    return this.query(
      `select username, account_status, created from all_users order by username`
    )
  }
}

/** Build a human Oracle type string from catalog metadata. */
function oracleType(
  dtype: string,
  len: number | null,
  prec: number | null,
  scale: number | null
): string {
  const t = dtype.toUpperCase()
  if (/CHAR/.test(t) && len) return `${t}(${len})`
  if (t === 'NUMBER') {
    if (prec && scale) return `NUMBER(${prec},${scale})`
    if (prec) return `NUMBER(${prec})`
    return 'NUMBER'
  }
  if (t === 'RAW' && len) return `RAW(${len})`
  return t
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}
