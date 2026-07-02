// Turn a materialized result set into a CREATE TABLE spec + insert rows, so any
// query/table result can be persisted as a new table. Column types are inferred
// conservatively from the data (falling back to text on any ambiguity), and
// column names are sanitized to safe identifiers.

import { isSqlDriver, sqlDialect } from '@shared/types'
import type { ColumnMeta, CreateTableSpec, DriverType, NewColumn, SqlDialect } from '@shared/types'

const TYPES: Record<SqlDialect, { int: string; real: string; bool: string; text: string }> = {
  postgres: { int: 'bigint', real: 'double precision', bool: 'boolean', text: 'text' },
  mysql: { int: 'bigint', real: 'double', bool: 'tinyint(1)', text: 'text' },
  sqlite: { int: 'INTEGER', real: 'REAL', bool: 'INTEGER', text: 'TEXT' },
  mssql: { int: 'bigint', real: 'float', bool: 'bit', text: 'nvarchar(max)' }
}

/** Engines that can create a table from a result (have createTable + applyChanges). */
export function canExportToTable(driver: DriverType): boolean {
  // Oracle maps to the postgres dialect for quoting, but its column types differ
  // (no bigint/text/boolean) — exclude it so we don't generate invalid DDL.
  return isSqlDriver(driver) && driver !== 'oracle'
}

const INT_RE = /^-?\d+$/
const NUM_RE = /^-?\d+(\.\d+)?$/

function isInt(v: unknown): boolean {
  if (typeof v === 'number') return Number.isInteger(v) && Number.isSafeInteger(v)
  if (typeof v === 'bigint') return true
  return typeof v === 'string' && INT_RE.test(v.trim()) && v.trim().length <= 18
}
function isNum(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  return typeof v === 'string' && NUM_RE.test(v.trim())
}
function isBool(v: unknown): boolean {
  return typeof v === 'boolean'
}

/** Pick a column type from the non-null sample values for the given engine. */
function inferType(values: unknown[], t: (typeof TYPES)[SqlDialect]): string {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '')
  if (present.length === 0) return t.text
  if (present.every(isBool)) return t.bool
  if (present.every(isInt)) return t.int
  if (present.every(isNum)) return t.real
  return t.text
}

/** Make a column name a safe, unique SQL identifier. */
function sanitize(name: string, used: Set<string>): string {
  let s = (name || 'col').replace(/[^A-Za-z0-9_]/g, '_')
  if (!s || /^[0-9]/.test(s)) s = `c_${s}`
  let candidate = s
  let i = 2
  while (used.has(candidate)) candidate = `${s}_${i++}`
  used.add(candidate)
  return candidate
}

export interface ResultTablePlan {
  spec: CreateTableSpec
  inserts: Record<string, unknown>[]
}

/**
 * Build the CREATE TABLE spec and the row objects to insert for a new table
 * named `name`, derived from `columns` + `rows`. Column names are sanitized and
 * the same sanitized names key the insert objects.
 */
export function planResultTable(
  name: string,
  columns: ColumnMeta[],
  rows: unknown[][],
  driver: DriverType
): ResultTablePlan {
  const t = TYPES[sqlDialect(driver)]
  const used = new Set<string>()
  const safeNames = columns.map((c) => sanitize(c.name, used))

  const newColumns: NewColumn[] = columns.map((_c, i) => ({
    name: safeNames[i],
    type: inferType(rows.map((r) => r[i]), t),
    nullable: true,
    primaryKey: false
  }))

  const inserts = rows.map((row) => {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < safeNames.length; i++) {
      let v = row[i]
      // Objects/arrays (e.g. parsed JSON columns) go in as JSON text.
      if (v !== null && v !== undefined && typeof v === 'object' && !(v instanceof Date)) {
        v = JSON.stringify(v)
      }
      obj[safeNames[i]] = v ?? null
    }
    return obj
  })

  return { spec: { name, columns: newColumns }, inserts }
}
