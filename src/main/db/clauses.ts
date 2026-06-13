import type { ErModel, ErTable, IndexDef, TableQueryOptions } from '@shared/types'

/** Assemble an ErModel from flat column rows + relation rows. */
export function buildErModel(
  cols: { t: string; col: string; isPk: boolean }[],
  rels: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }[]
): ErModel {
  const fkSet = new Set(rels.map((r) => `${r.fromTable}.${r.fromColumn}`))
  const tables = new Map<string, ErTable>()
  for (const c of cols) {
    let t = tables.get(c.t)
    if (!t) {
      t = { name: c.t, columns: [] }
      tables.set(c.t, t)
    }
    t.columns.push({
      name: c.col,
      isPrimaryKey: c.isPk,
      isForeignKey: fkSet.has(`${c.t}.${c.col}`)
    })
  }
  return { tables: [...tables.values()], relations: rels }
}

/** Collapse per-column index rows (pre-ordered) into IndexDef[]. */
export function groupIndexes(
  rows: { name: string; unique: boolean; col: string }[]
): IndexDef[] {
  const map = new Map<string, IndexDef>()
  for (const r of rows) {
    let idx = map.get(r.name)
    if (!idx) {
      idx = { name: r.name, columns: [], unique: r.unique }
      map.set(r.name, idx)
    }
    idx.columns.push(r.col)
  }
  return [...map.values()]
}

/** Default index name when the user doesn't supply one. */
export function indexName(table: string, columns: string[]): string {
  return `idx_${table}_${columns.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60)
}

export type Quote = (ident: string) => string
export type Placeholder = (index: number) => string // 1-based

export interface BuiltClauses {
  where: string
  order: string
  params: unknown[]
}

/**
 * Build parameterized WHERE/ORDER BY clauses for a table page. `quote` wraps an
 * identifier for the target engine; `ph` produces a positional placeholder
 * ($1, ?, @p0, …) for the given 1-based parameter index.
 */
export function buildClauses(opts: TableQueryOptions, quote: Quote, ph: Placeholder): BuiltClauses {
  const params: unknown[] = []
  let where = ''

  const filters = (opts.filters ?? []).filter((f) => f.column)
  if (filters.length) {
    const parts = filters.map((f) => {
      const col = quote(f.column)
      switch (f.op) {
        case 'is null':
          return `${col} is null`
        case 'not null':
          return `${col} is not null`
        case 'contains':
          params.push(`%${f.value ?? ''}%`)
          return `${col} like ${ph(params.length)}`
        case 'starts':
          params.push(`${f.value ?? ''}%`)
          return `${col} like ${ph(params.length)}`
        default:
          params.push(f.value ?? '')
          return `${col} ${f.op} ${ph(params.length)}`
      }
    })
    where = ' where ' + parts.join(' and ')
  }

  let order = ''
  if (opts.sort?.column) {
    order = ` order by ${quote(opts.sort.column)} ${opts.sort.dir === 'desc' ? 'desc' : 'asc'}`
  }

  return { where, order, params }
}
