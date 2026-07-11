import type {
  ErModel,
  ErTable,
  IndexDef,
  SchemaSnapshot,
  SchemaTable,
  TableQueryOptions
} from '@shared/types'

/** Assemble a SchemaSnapshot from flat column rows (pre-ordered). */
export function buildSnapshot(
  rows: { t: string; col: string; type: string; nullable: boolean; isPk: boolean }[]
): SchemaSnapshot {
  const map = new Map<string, SchemaTable>()
  for (const r of rows) {
    let t = map.get(r.t)
    if (!t) {
      t = { name: r.t, columns: [] }
      map.set(r.t, t)
    }
    t.columns.push({ name: r.col, type: r.type, nullable: r.nullable, isPrimaryKey: r.isPk })
  }
  return [...map.values()]
}

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

/**
 * Split a comma-separated `in` / `not in` value into trimmed, non-empty items.
 * A leading/trailing quote pair around an item is stripped so users can write
 * `'a, b', c` when a literal value itself contains a comma.
 */
export function splitList(value: string | undefined): string[] {
  const raw = value ?? ''
  const items: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ',') {
      items.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  items.push(cur.trim())
  return items.filter((s) => s.length > 0)
}

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
        case 'not contains':
          params.push(`%${f.value ?? ''}%`)
          return `${col} not like ${ph(params.length)}`
        case 'starts':
          params.push(`${f.value ?? ''}%`)
          return `${col} like ${ph(params.length)}`
        case 'ends':
          params.push(`%${f.value ?? ''}`)
          return `${col} like ${ph(params.length)}`
        case 'like':
          params.push(f.value ?? '')
          return `${col} like ${ph(params.length)}`
        case 'not like':
          params.push(f.value ?? '')
          return `${col} not like ${ph(params.length)}`
        case 'in':
        case 'not in': {
          const items = splitList(f.value)
          if (!items.length) return f.op === 'in' ? '1 = 0' : '1 = 1'
          const phs = items.map((v) => {
            params.push(v)
            return ph(params.length)
          })
          return `${col} ${f.op === 'in' ? 'in' : 'not in'} (${phs.join(', ')})`
        }
        case 'between': {
          params.push(f.value ?? '')
          const lo = ph(params.length)
          params.push(f.value2 ?? '')
          const hi = ph(params.length)
          return `${col} between ${lo} and ${hi}`
        }
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
