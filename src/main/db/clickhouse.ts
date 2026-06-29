import { createClient, type ClickHouseClient } from '@clickhouse/client'
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

const q = (ident: string): string => `\`${ident.replace(/`/g, '``')}\``

/** Escape a JS value into a ClickHouse SQL literal (no client-side bind types). */
function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** True when a statement returns a result set (vs. a DDL/DML command). */
function returnsRows(sql: string): boolean {
  return /^\s*(select|show|describe|desc|explain|with|exists)\b/i.test(sql)
}

export class ClickHouseAdapter implements DbAdapter {
  private client?: ClickHouseClient
  constructor(public readonly config: ConnectionConfig) {}

  private db(): string {
    return this.config.database || 'default'
  }

  private make(): ClickHouseClient {
    const scheme = this.config.ssl ? 'https' : 'http'
    const url = `${scheme}://${this.config.host ?? 'localhost'}:${this.config.port ?? 8123}`
    return createClient({
      url,
      username: this.config.user || 'default',
      password: this.config.password ?? '',
      database: this.db(),
      request_timeout: 30_000
    })
  }

  async test(): Promise<void> {
    const client = this.make()
    try {
      const res = await client.ping()
      if (!res.success) throw res.error
    } finally {
      await client.close()
    }
  }

  async connect(): Promise<void> {
    this.client = this.make()
    const res = await this.client.ping()
    if (!res.success) throw res.error
  }

  async disconnect(): Promise<void> {
    await this.client?.close()
    this.client = undefined
  }

  /** Run a statement, returning a uniform result (rows for SELECT, else empty). */
  private async run(sql: string): Promise<QueryResult> {
    const start = now()
    if (returnsRows(sql)) {
      const rs = await this.client!.query({ query: sql, format: 'JSONCompact' })
      const body = (await rs.json()) as {
        meta?: { name: string }[]
        data?: unknown[][]
      }
      const names = (body.meta ?? []).map((m) => m.name)
      const rows = (body.data ?? []).map((r) => r.map(normalizeValue))
      return { columns: names.map((name) => ({ name })), rows, rowCount: rows.length, durationMs: now() - start }
    }
    await this.client!.command({ query: sql })
    return { columns: [], rows: [], rowCount: 0, durationMs: now() - start }
  }

  async query(sqlText: string): Promise<QueryResult> {
    return this.run(sqlText.replace(/;\s*$/, ''))
  }

  private ident(table: TableInfo): string {
    const schema = table.schema || this.db()
    return `${q(schema)}.${q(table.name)}`
  }

  /** Reuse the shared clause builder, then inline-escape params (CH binds are typed). */
  private clauses(opts: TableQueryOptions): { where: string; order: string } {
    const { where, order, params } = buildClauses(opts, q, (i) => `__P${i}__`)
    let w = where
    params.forEach((v, i) => {
      w = w.replace(`__P${i + 1}__`, lit(v))
    })
    return { where: w, order }
  }

  async listTables(): Promise<TableInfo[]> {
    const res = await this.run(
      `select name, engine from system.tables where database = ${lit(this.db())} order by name`
    )
    return res.rows.map((r) => ({
      name: String(r[0]),
      type: String(r[1]).toLowerCase().includes('view') ? 'view' : 'table'
    }))
  }

  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const { where, order } = this.clauses(opts)
    return this.run(
      `select * from ${this.ident(table)}${where}${order} limit ${Number(opts.limit)} offset ${Number(opts.offset)}`
    )
  }

  async countRows(table: TableInfo, opts: TableQueryOptions): Promise<number> {
    const { where } = this.clauses(opts)
    const res = await this.run(`select count() from ${this.ident(table)}${where}`)
    return Number(res.rows[0]?.[0] ?? 0)
  }

  async primaryKeys(table: TableInfo): Promise<string[]> {
    const res = await this.run(
      `select name from system.columns
        where database = ${lit(table.schema || this.db())} and table = ${lit(table.name)}
          and is_in_primary_key = 1`
    )
    return res.rows.map((r) => String(r[0]))
  }

  async schema(): Promise<Record<string, string[]>> {
    const res = await this.run(
      `select table, name from system.columns where database = ${lit(this.db())} order by table, position`
    )
    const map: Record<string, string[]> = {}
    for (const r of res.rows) (map[String(r[0])] ??= []).push(String(r[1]))
    return map
  }

  async applyChanges(table: TableInfo, cs: RowChangeSet): Promise<number> {
    const t = this.ident(table)
    let affected = 0
    for (const pk of cs.deletes) {
      const where = Object.keys(pk).map((c) => `${q(c)} = ${lit(pk[c])}`).join(' and ')
      await this.run(`alter table ${t} delete where ${where}`)
      affected++
    }
    for (const e of cs.updates) {
      const set = Object.keys(e.changes).map((c) => `${q(c)} = ${lit(e.changes[c])}`).join(', ')
      const where = Object.keys(e.pk).map((c) => `${q(c)} = ${lit(e.pk[c])}`).join(' and ')
      await this.run(`alter table ${t} update ${set} where ${where}`)
      affected++
    }
    for (const row of cs.inserts) {
      const cols = Object.keys(row)
      if (!cols.length) continue
      const names = cols.map(q).join(', ')
      const vals = cols.map((c) => lit(row[c])).join(', ')
      await this.run(`insert into ${t} (${names}) values (${vals})`)
      affected++
    }
    return affected
  }

  async tableSizes(): Promise<TableSizeInfo[]> {
    const res = await this.run(
      `select table, sum(rows) as rows, sum(bytes_on_disk) as bytes
         from system.parts where active and database = ${lit(this.db())}
        group by table order by bytes desc`
    )
    return res.rows.map((r) => ({ name: String(r[0]), rows: toNum(r[1]), bytes: toNum(r[2]) }))
  }

  async tableStructure(table: TableInfo): Promise<TableStructure> {
    const cols = await this.run(
      `select name, type, default_expression, is_in_primary_key
         from system.columns
        where database = ${lit(table.schema || this.db())} and table = ${lit(table.name)}
        order by position`
    )
    return {
      columns: cols.rows.map((c) => ({
        name: String(c[0]),
        type: String(c[1]),
        nullable: String(c[1]).startsWith('Nullable('),
        default: c[2] ? String(c[2]) : null,
        isPrimaryKey: Number(c[3]) === 1
      })),
      foreignKeys: [], // ClickHouse has no foreign keys
      indexes: []
    }
  }

  async tableDDL(table: TableInfo): Promise<string> {
    const res = await this.run(`show create table ${this.ident(table)}`)
    return `${String(res.rows[0]?.[0] ?? '')};`
  }

  async erModel(): Promise<ErModel> {
    const cols = await this.run(
      `select table, name, is_in_primary_key from system.columns
        where database = ${lit(this.db())} order by table, position`
    )
    return buildErModel(
      cols.rows.map((r) => ({ t: String(r[0]), col: String(r[1]), isPk: Number(r[2]) === 1 })),
      [] // no relations
    )
  }

  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const cols = await this.run(
      `select table, name, type, is_in_primary_key from system.columns
        where database = ${lit(this.db())} order by table, position`
    )
    return buildSnapshot(
      cols.rows.map((r) => ({
        t: String(r[0]),
        col: String(r[1]),
        type: String(r[2]),
        nullable: String(r[2]).startsWith('Nullable('),
        isPk: Number(r[3]) === 1
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
        sql = `alter table ${t} modify column ${q(op.name)} ${op.type}`
        break
      default:
        throw new Error(`ClickHouse does not support this change (${op.kind}).`)
    }
    await this.run(sql)
  }

  async createTable(spec: CreateTableSpec): Promise<void> {
    const ident = `${q(this.db())}.${q(assertIdent(spec.name))}`
    const lines = spec.columns.map((c) => `${q(assertIdent(c.name))} ${c.type}`)
    const pks = spec.columns.filter((c) => c.primaryKey).map((c) => q(c.name))
    // ClickHouse needs an engine + ORDER BY (use the PK, else tuple()).
    const orderBy = pks.length ? `(${pks.join(', ')})` : 'tuple()'
    await this.run(`create table ${ident} (${lines.join(', ')}) engine = MergeTree() order by ${orderBy}`)
  }

  async dropTables(tables: TableInfo[], _opts: DropTableOptions): Promise<void> {
    for (const t of tables) await this.run(`drop table if exists ${this.ident(t)}`)
  }

  async truncateTables(tables: TableInfo[], _opts: TruncateOptions): Promise<void> {
    for (const t of tables) await this.run(`truncate table ${this.ident(t)}`)
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.run('select name from system.databases order by name')
    return res.rows.map((r) => String(r[0]))
  }

  async createDatabase(name: string): Promise<void> {
    await this.run(`create database ${q(assertIdent(name))}`)
  }

  async dropDatabase(name: string): Promise<void> {
    await this.run(`drop database ${q(assertIdent(name))}`)
  }
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}
