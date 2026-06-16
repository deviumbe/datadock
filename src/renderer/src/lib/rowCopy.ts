// Format a single result-grid row for the clipboard as JSON, CSV, or a SQL
// INSERT. These are convenience copies (pasted into other tools), not executed,
// so quoting is kept simple and dialect-agnostic.

import type { ColumnMeta } from '@shared/types'

function obj(columns: ColumnMeta[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  columns.forEach((c, i) => (out[c.name] = row[i] ?? null))
  return out
}

export function rowToJson(columns: ColumnMeta[], row: unknown[]): string {
  return JSON.stringify(obj(columns, row), null, 2)
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function rowToCsv(columns: ColumnMeta[], row: unknown[]): string {
  const header = columns.map((c) => csvCell(c.name)).join(',')
  const values = columns.map((_, i) => csvCell(row[i])).join(',')
  return `${header}\n${values}`
}

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/'/g, "''")}'`
}

export function rowToInsert(table: string, columns: ColumnMeta[], row: unknown[]): string {
  const cols = columns.map((c) => c.name).join(', ')
  const vals = columns.map((_, i) => sqlValue(row[i])).join(', ')
  return `INSERT INTO ${table} (${cols}) VALUES (${vals});`
}

/** One INSERT statement per row (e.g. for a multi-row selection). */
export function rowsToInserts(table: string, columns: ColumnMeta[], rows: unknown[][]): string {
  return rows.map((r) => rowToInsert(table, columns, r)).join('\n')
}

/**
 * One UPDATE per row, keyed by `pkColumns` in the WHERE clause. Primary-key
 * columns are excluded from the SET list. Rows with a missing PK value are
 * skipped (can't be addressed safely).
 */
export function rowsToUpdates(
  table: string,
  columns: ColumnMeta[],
  rows: unknown[][],
  pkColumns: string[]
): string {
  const pkSet = new Set(pkColumns)
  const setCols = columns.filter((c) => !pkSet.has(c.name))
  const out: string[] = []
  for (const row of rows) {
    const set = setCols
      .map((c) => `${c.name} = ${sqlValue(row[columns.findIndex((x) => x.name === c.name)])}`)
      .join(', ')
    const where = pkColumns
      .map((k) => `${k} = ${sqlValue(row[columns.findIndex((x) => x.name === k)])}`)
      .join(' AND ')
    if (!where) continue
    out.push(`UPDATE ${table} SET ${set} WHERE ${where};`)
  }
  return out.join('\n')
}
