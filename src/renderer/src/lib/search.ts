// Build per-table search queries for the universal "find any value" search.
import type { SchemaTable } from '@shared/types'

function quote(driver: string, id: string): string {
  if (driver === 'mysql') return `\`${id}\``
  if (driver === 'mssql') return `[${id}]`
  return `"${id}"`
}

// Column types worth a substring search (skip numerics/dates/blobs to avoid
// cast errors and meaningless matches).
const TEXT_RE = /char|text|string|clob|citext|uuid|json|enum|\bname\b|varchar|nvarchar/i

export function textColumns(t: SchemaTable): string[] {
  return t.columns.filter((c) => TEXT_RE.test(c.type)).map((c) => c.name)
}

/**
 * A case-insensitive `LIKE %term%` across the given text columns of one table.
 * The term is lowercased + single-quote-escaped; `LOWER(col)` keeps it
 * uniformly case-insensitive across dialects.
 */
export function buildSearchSql(
  driver: string,
  table: string,
  cols: string[],
  term: string,
  limit = 20
): string {
  const t = quote(driver, table)
  const esc = term.replace(/'/g, "''").toLowerCase()
  const conds = cols.map((c) => `LOWER(${quote(driver, c)}) LIKE '%${esc}%'`).join(' OR ')
  if (driver === 'mssql') return `SELECT TOP ${limit} * FROM ${t} WHERE ${conds}`
  return `SELECT * FROM ${t} WHERE ${conds} LIMIT ${limit}`
}
