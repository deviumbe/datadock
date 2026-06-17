// Structural index analysis — finds redundant indexes, foreign keys without a
// supporting index, and tables with no primary key. All read-only heuristics.
import type { ColumnDef, ForeignKeyDef, IndexDef } from '@shared/types'

export interface AnalyzedTable {
  name: string
  columns: ColumnDef[]
  foreignKeys: ForeignKeyDef[]
  indexes: IndexDef[]
}

export interface IndexFinding {
  table: string
  kind: 'redundant' | 'unindexed-fk' | 'no-pk'
  title: string
  detail: string
  ddl?: string
  severity: 'warn' | 'info'
}

function quote(driver: string, id: string): string {
  if (driver === 'mysql') return `\`${id}\``
  if (driver === 'mssql') return `[${id}]`
  return `"${id}"`
}

function dropIndex(driver: string, table: string, name: string): string {
  if (driver === 'mysql' || driver === 'mssql') {
    return `DROP INDEX ${quote(driver, name)} ON ${quote(driver, table)};`
  }
  return `DROP INDEX ${quote(driver, name)};`
}

function createIndex(driver: string, table: string, col: string): string {
  return `CREATE INDEX ${quote(driver, `idx_${table}_${col}`)} ON ${quote(driver, table)} (${quote(driver, col)});`
}

const isPrefix = (a: string[], b: string[]): boolean =>
  a.length <= b.length && a.every((c, i) => c === b[i])

export function analyzeIndexes(tables: AnalyzedTable[], driver: string): IndexFinding[] {
  const out: IndexFinding[] = []

  for (const t of tables) {
    // ---- redundant indexes: columns are a (non-unique) prefix of another ----
    for (const a of t.indexes) {
      if (a.unique) continue // a unique index is a constraint, never "redundant"
      const covering = t.indexes.find(
        (b) =>
          b !== a &&
          b.columns.length >= a.columns.length &&
          isPrefix(a.columns, b.columns) &&
          // tie-break for exact duplicates: only flag one of them
          !(b.columns.length === a.columns.length && b.name < a.name)
      )
      if (covering) {
        out.push({
          table: t.name,
          kind: 'redundant',
          severity: 'warn',
          title: `Redundant index ${a.name}`,
          detail: `(${a.columns.join(', ')}) is already covered by ${covering.name} (${covering.columns.join(', ')}).`,
          ddl: dropIndex(driver, t.name, a.name)
        })
      }
    }

    // ---- foreign keys without a supporting index ----
    const leading = new Set<string>()
    for (const idx of t.indexes) if (idx.columns[0]) leading.add(idx.columns[0])
    for (const c of t.columns) if (c.isPrimaryKey) leading.add(c.name)
    for (const fk of t.foreignKeys) {
      if (!leading.has(fk.column)) {
        out.push({
          table: t.name,
          kind: 'unindexed-fk',
          severity: 'warn',
          title: `Unindexed foreign key ${fk.column}`,
          detail: `${fk.column} → ${fk.refTable}.${fk.refColumn} has no index; joins and cascading deletes on it scan the whole table.`,
          ddl: createIndex(driver, t.name, fk.column)
        })
      }
    }

    // ---- no primary key ----
    if (!t.columns.some((c) => c.isPrimaryKey)) {
      out.push({
        table: t.name,
        kind: 'no-pk',
        severity: 'info',
        title: `No primary key`,
        detail: `${t.name} has no primary key — rows can't be uniquely addressed for editing or diffing.`
      })
    }
  }

  // warnings first, then by table
  return out.sort((a, b) =>
    a.severity === b.severity ? a.table.localeCompare(b.table) : a.severity === 'warn' ? -1 : 1
  )
}
