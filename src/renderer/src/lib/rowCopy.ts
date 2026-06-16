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
