// Driver-specific SQL builder for the analytics module, usable in the main
// process (the report scheduler). Mirrors src/renderer/src/lib/analyticsSql.ts;
// kept separate so the main bundle has no renderer/Vue dependency.
import type { ChartEncoding, DatasetSource, FilterSpec, TimeBucket } from '@shared/types'

function quote(driver: string, id: string): string {
  if (driver === 'mysql') return `\`${id}\``
  if (driver === 'mssql') return `[${id}]`
  return `"${id}"`
}
function lit(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`
}

function fromExpr(driver: string, source: DatasetSource): string {
  if (source.kind === 'sql') {
    const inner = source.sql.trim().replace(/;\s*$/, '')
    return `(${inner}) AS _ds`
  }
  return `${quote(driver, source.table)} AS _ds`
}

function aggExpr(driver: string, agg: string, col?: string): string {
  if (agg === 'count' || !col) return 'COUNT(*)'
  return `${agg.toUpperCase()}(${quote(driver, col)})`
}

function bucketExpr(driver: string, col: string, bucket: TimeBucket): string {
  const c = quote(driver, col)
  if (bucket === 'none') return c
  if (driver === 'postgres') {
    const fmt = { day: 'YYYY-MM-DD', week: 'IYYY-"W"IW', month: 'YYYY-MM', quarter: 'YYYY-"Q"Q', year: 'YYYY' }[bucket]
    return `to_char(${c}, '${fmt}')`
  }
  if (driver === 'mysql') {
    switch (bucket) {
      case 'day': return `DATE_FORMAT(${c}, '%Y-%m-%d')`
      case 'week': return `DATE_FORMAT(${c}, '%x-W%v')`
      case 'month': return `DATE_FORMAT(${c}, '%Y-%m')`
      case 'quarter': return `CONCAT(YEAR(${c}), '-Q', QUARTER(${c}))`
      case 'year': return `DATE_FORMAT(${c}, '%Y')`
    }
  }
  if (driver === 'mssql') {
    switch (bucket) {
      case 'day': return `FORMAT(${c}, 'yyyy-MM-dd')`
      case 'week': return `CONCAT(YEAR(${c}), '-W', RIGHT('0' + CAST(DATEPART(ISO_WEEK, ${c}) AS varchar), 2))`
      case 'month': return `FORMAT(${c}, 'yyyy-MM')`
      case 'quarter': return `CONCAT(YEAR(${c}), '-Q', DATEPART(QUARTER, ${c}))`
      case 'year': return `FORMAT(${c}, 'yyyy')`
    }
  }
  switch (bucket) {
    case 'day': return `strftime('%Y-%m-%d', ${c})`
    case 'week': return `strftime('%Y-W%W', ${c})`
    case 'month': return `strftime('%Y-%m', ${c})`
    case 'quarter': return `(strftime('%Y', ${c}) || '-Q' || ((cast(strftime('%m', ${c}) as integer) + 2) / 3))`
    case 'year': return `strftime('%Y', ${c})`
  }
  return c
}

function whereClause(driver: string, filters?: FilterSpec[]): string {
  const fs = (filters ?? []).filter((f) => f.column)
  if (!fs.length) return ''
  const parts = fs.map((f) => {
    const col = quote(driver, f.column)
    switch (f.op) {
      case 'is null': return `${col} IS NULL`
      case 'not null': return `${col} IS NOT NULL`
      case 'contains': return `${col} LIKE ${lit(`%${f.value ?? ''}%`)}`
      case 'starts': return `${col} LIKE ${lit(`${f.value ?? ''}%`)}`
      default: return `${col} ${f.op} ${lit(f.value ?? '')}`
    }
  })
  return ' WHERE ' + parts.join(' AND ')
}

export function datasetRowsSql(driver: string, source: DatasetSource, limit = 5000): string {
  const from = fromExpr(driver, source)
  if (driver === 'mssql') return `SELECT TOP ${limit} * FROM ${from}`
  return `SELECT * FROM ${from} LIMIT ${limit}`
}

export function buildChartSql(driver: string, source: DatasetSource, encoding: ChartEncoding): string {
  const from = fromExpr(driver, source)
  const where = whereClause(driver, encoding.filters)
  const y = `${aggExpr(driver, encoding.yAgg, encoding.yColumn)} AS y`

  if (!encoding.x) {
    if (driver === 'mssql') return `SELECT TOP 1 ${y} FROM ${from}${where}`
    return `SELECT ${y} FROM ${from}${where}`
  }

  const xExpr = bucketExpr(driver, encoding.x, encoding.bucket ?? 'none')
  const sel = [`${xExpr} AS x`]
  const groupBy = [xExpr]
  if (encoding.series) {
    const s = quote(driver, encoding.series)
    sel.push(`${s} AS series`)
    groupBy.push(s)
  }
  sel.push(y)
  const limit = encoding.limit && encoding.limit > 0 ? encoding.limit : 1000
  const core =
    `SELECT ${sel.join(', ')} FROM ${from}${where}` +
    ` GROUP BY ${groupBy.join(', ')} ORDER BY ${xExpr}`
  if (driver === 'mssql') return core.replace(/^SELECT /, `SELECT TOP ${limit} `)
  return `${core} LIMIT ${limit}`
}
