import { InfluxDB } from '@influxdata/influxdb-client'
import type { ConnectionConfig, QueryResult, TableInfo, TableQueryOptions } from '@shared/types'
import { DbAdapter, now } from './types'

/**
 * InfluxDB v2 adapter. Unlike the SQL engines this speaks Flux, so the query
 * editor sends raw Flux. "Tables" are surfaced as the measurements inside the
 * configured bucket. This is intentionally a lighter integration than the SQL
 * drivers for the first release.
 */
export class InfluxAdapter implements DbAdapter {
  private client?: InfluxDB
  constructor(public readonly config: ConnectionConfig) {}

  private makeClient(): InfluxDB {
    if (!this.config.url) throw new Error('No InfluxDB URL configured')
    if (!this.config.token) throw new Error('No InfluxDB token configured')
    return new InfluxDB({ url: this.config.url, token: this.config.token, timeout: 15_000 })
  }

  private get org(): string {
    if (!this.config.org) throw new Error('No InfluxDB org configured')
    return this.config.org
  }

  async test(): Promise<void> {
    const client = this.makeClient()
    // buckets() is cheap and validates url + token + org.
    await runFlux(client, this.org, 'buckets() |> limit(n: 1)')
  }

  async connect(): Promise<void> {
    this.client = this.makeClient()
  }

  async disconnect(): Promise<void> {
    this.client = undefined
  }

  async listTables(): Promise<TableInfo[]> {
    const bucket = this.config.bucket
    if (!bucket) return []
    const flux = `import "influxdata/influxdb/schema"
schema.measurements(bucket: "${bucket.replace(/"/g, '\\"')}")`
    const res = await runFlux(this.client!, this.org, flux)
    const valueIdx = res.columns.findIndex((c) => c.name === '_value')
    const idx = valueIdx >= 0 ? valueIdx : res.columns.length - 1
    return res.rows.map((row) => ({ name: String(row[idx]), type: 'table' as const }))
  }

  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const bucket = this.config.bucket ?? ''
    const flux = `from(bucket: "${bucket.replace(/"/g, '\\"')}")
  |> range(start: -30d)
  |> filter(fn: (r) => r._measurement == "${table.name.replace(/"/g, '\\"')}")
  |> limit(n: ${opts.limit})`
    return this.query(flux)
  }

  async query(flux: string): Promise<QueryResult> {
    return runFlux(this.client!, this.org, flux)
  }
}

function runFlux(client: InfluxDB, org: string, flux: string): Promise<QueryResult> {
  const queryApi = client.getQueryApi(org)
  const start = now()
  const rows: unknown[][] = []
  let columns: { name: string; type?: string }[] = []

  return new Promise<QueryResult>((resolve, reject) => {
    queryApi.queryRows(flux, {
      next(row, tableMeta) {
        if (columns.length === 0) {
          columns = tableMeta.columns.map((c) => ({ name: c.label, type: c.dataType }))
        }
        rows.push(tableMeta.columns.map((c) => row[c.index]))
      },
      error(err) {
        reject(err)
      },
      complete() {
        resolve({ columns, rows, rowCount: rows.length, durationMs: now() - start })
      }
    })
  })
}
