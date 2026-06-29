import { BigQuery } from '@google-cloud/bigquery'
import type {
  ConnectionConfig,
  ErModel,
  QueryResult,
  SchemaSnapshot,
  TableInfo,
  TableQueryOptions,
  TableSizeInfo,
  TableStructure
} from '@shared/types'
import { DbAdapter, now, toNum } from './types'
import { buildClauses, buildErModel, buildSnapshot } from './clauses'

const q = (ident: string): string => `\`${ident.replace(/`/g, '')}\``

/**
 * BigQuery is append-oriented and has no primary keys, so this adapter is
 * read/browse/query only — it deliberately omits row editing and DDL helpers.
 */
export class BigQueryAdapter implements DbAdapter {
  private client?: BigQuery
  constructor(public readonly config: ConnectionConfig) {}

  private dataset(): string {
    if (!this.config.database) throw new Error('BigQuery dataset (database) is required')
    return this.config.database
  }

  private make(): BigQuery {
    if (!this.config.projectId) throw new Error('BigQuery project ID is required')
    return new BigQuery({
      projectId: this.config.projectId,
      keyFilename: this.config.filePath || undefined
    })
  }

  async test(): Promise<void> {
    await this.make().query({ query: 'select 1', maxResults: 1 })
  }

  async connect(): Promise<void> {
    this.client = this.make()
  }

  async disconnect(): Promise<void> {
    this.client = undefined
  }

  private async run(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const start = now()
    const [job] = await this.client!.createQueryJob({
      query: sql,
      params: params.length ? params : undefined
    })
    const [rows, , apiResponse] = await job.getQueryResults()
    const durationMs = now() - start
    const fields = (apiResponse?.schema?.fields ?? []) as { name?: string }[]
    let names = fields.map((f) => String(f.name))
    if (!names.length && rows.length) names = Object.keys(rows[0] as Record<string, unknown>)
    const out = (rows as Record<string, unknown>[]).map((row) => names.map((n) => normalizeValue(row[n])))
    return { columns: names.map((name) => ({ name })), rows: out, rowCount: out.length, durationMs }
  }

  async query(sqlText: string): Promise<QueryResult> {
    return this.run(sqlText.replace(/;\s*$/, ''))
  }

  private ident(table: TableInfo): string {
    return `${q(this.dataset())}.${q(table.name)}`
  }

  async listTables(): Promise<TableInfo[]> {
    const res = await this.run(
      `select table_name, table_type from ${q(this.dataset())}.INFORMATION_SCHEMA.TABLES order by table_name`
    )
    return res.rows.map((r) => ({
      name: String(r[0]),
      type: String(r[1]).toUpperCase().includes('VIEW') ? 'view' : 'table'
    }))
  }

  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const { where, order, params } = buildClauses(opts, q, () => '?')
    return this.run(
      `select * from ${this.ident(table)}${where}${order} limit ${Number(opts.limit)} offset ${Number(opts.offset)}`,
      params
    )
  }

  async countRows(table: TableInfo, opts: TableQueryOptions): Promise<number> {
    const { where, params } = buildClauses(opts, q, () => '?')
    const res = await this.run(`select count(*) from ${this.ident(table)}${where}`, params)
    return Number(res.rows[0]?.[0] ?? 0)
  }

  async schema(): Promise<Record<string, string[]>> {
    const res = await this.run(
      `select table_name, column_name from ${q(this.dataset())}.INFORMATION_SCHEMA.COLUMNS
        order by table_name, ordinal_position`
    )
    const map: Record<string, string[]> = {}
    for (const r of res.rows) (map[String(r[0])] ??= []).push(String(r[1]))
    return map
  }

  async tableSizes(): Promise<TableSizeInfo[]> {
    const res = await this.run(
      `select table_name, total_rows, total_logical_bytes
         from ${q(this.dataset())}.INFORMATION_SCHEMA.TABLE_STORAGE order by total_logical_bytes desc`
    )
    return res.rows.map((r) => ({ name: String(r[0]), rows: toNum(r[1]), bytes: toNum(r[2]) }))
  }

  async tableStructure(table: TableInfo): Promise<TableStructure> {
    const cols = await this.run(
      `select column_name, data_type, is_nullable
         from ${q(this.dataset())}.INFORMATION_SCHEMA.COLUMNS
        where table_name = ? order by ordinal_position`,
      [table.name]
    )
    return {
      columns: cols.rows.map((c) => ({
        name: String(c[0]),
        type: String(c[1]),
        nullable: String(c[2]).toUpperCase() === 'YES',
        default: null,
        isPrimaryKey: false
      })),
      foreignKeys: [],
      indexes: []
    }
  }

  async tableDDL(table: TableInfo): Promise<string> {
    const res = await this.run(
      `select ddl from ${q(this.dataset())}.INFORMATION_SCHEMA.TABLES where table_name = ?`,
      [table.name]
    )
    return String(res.rows[0]?.[0] ?? '')
  }

  async erModel(): Promise<ErModel> {
    const cols = await this.run(
      `select table_name, column_name from ${q(this.dataset())}.INFORMATION_SCHEMA.COLUMNS
        order by table_name, ordinal_position`
    )
    return buildErModel(
      cols.rows.map((r) => ({ t: String(r[0]), col: String(r[1]), isPk: false })),
      []
    )
  }

  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const cols = await this.run(
      `select table_name, column_name, data_type, is_nullable
         from ${q(this.dataset())}.INFORMATION_SCHEMA.COLUMNS order by table_name, ordinal_position`
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
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`
  if (typeof v === 'object') {
    // BigQuery wraps DATE/TIMESTAMP/NUMERIC etc. in objects exposing `.value`.
    const obj = v as { value?: unknown }
    if ('value' in obj && obj.value != null && typeof obj.value !== 'object') return String(obj.value)
    return JSON.stringify(v)
  }
  return v
}
