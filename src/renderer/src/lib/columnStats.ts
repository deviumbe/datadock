// Build a one-row profiling query for a single column: totals, distinct, nulls
// and min/max. Dialect-aware quoting; pg-family engines fold onto postgres.
import { sqlDialect } from '@shared/types'
import type { TableInfo } from '@shared/types'

function quote(driver: string, id: string): string {
  const d = sqlDialect(driver)
  if (d === 'mysql') return `\`${id.replace(/`/g, '``')}\``
  if (d === 'mssql') return `[${id.replace(/]/g, ']]')}]`
  return `"${id.replace(/"/g, '""')}"`
}

function ident(driver: string, table: TableInfo): string {
  return table.schema
    ? `${quote(driver, table.schema)}.${quote(driver, table.name)}`
    : quote(driver, table.name)
}

export function buildStatsSql(driver: string, table: TableInfo, column: string): string {
  const col = quote(driver, column)
  return (
    `select count(*) as total, count(${col}) as non_null, ` +
    `count(distinct ${col}) as distinct_count, ` +
    `min(${col}) as min_val, max(${col}) as max_val ` +
    `from ${ident(driver, table)}`
  )
}
