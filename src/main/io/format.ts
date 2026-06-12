import ExcelJS from 'exceljs'
import type { ColumnMeta, DriverType } from '@shared/types'

export type Dialect = DriverType

export function quoteIdent(name: string, dialect: Dialect): string {
  switch (dialect) {
    case 'mysql':
      return `\`${name.replace(/`/g, '``')}\``
    case 'mssql':
      return `[${name.replace(/]/g, ']]')}]`
    default:
      return `"${name.replace(/"/g, '""')}"`
  }
}

export function escapeSqlValue(v: unknown, dialect: Dialect): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') {
    return dialect === 'postgres' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0'
  }
  return `'${String(v).replace(/'/g, "''")}'`
}

// ---- CSV --------------------------------------------------------------------

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function jsonObject(columns: ColumnMeta[], row: unknown[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((c, i) => [c.name, row[i]]))
}

export function buildCsv(columns: ColumnMeta[], rows: unknown[][]): string {
  const header = columns.map((c) => csvCell(c.name)).join(',')
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
  return `${header}\r\n${body}`
}

// ---- JSON -------------------------------------------------------------------

export function buildJson(columns: ColumnMeta[], rows: unknown[][]): string {
  const names = columns.map((c) => c.name)
  const objects = rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])))
  return JSON.stringify(objects, null, 2)
}

// ---- XLSX -------------------------------------------------------------------

export async function buildXlsx(columns: ColumnMeta[], rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Export')
  ws.addRow(columns.map((c) => c.name))
  ws.getRow(1).font = { bold: true }
  for (const r of rows) {
    ws.addRow(r.map((v) => (v === null || v === undefined ? null : (v as ExcelJS.CellValue))))
  }
  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out)
}

// ---- SQL INSERTs ------------------------------------------------------------

export function buildInserts(
  tableName: string,
  columns: ColumnMeta[],
  rows: unknown[][],
  dialect: Dialect,
  batchSize = 200
): string {
  if (rows.length === 0) return ''
  const qtable = quoteIdent(tableName, dialect)
  const qcols = columns.map((c) => quoteIdent(c.name, dialect)).join(', ')
  const lines: string[] = []
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const values = batch
      .map((r) => `(${r.map((v) => escapeSqlValue(v, dialect)).join(', ')})`)
      .join(',\n')
    lines.push(`INSERT INTO ${qtable} (${qcols}) VALUES\n${values};`)
  }
  return lines.join('\n')
}
