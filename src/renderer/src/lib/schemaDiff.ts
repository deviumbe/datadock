import type { SchemaColumn, SchemaSnapshot } from '@shared/types'

export type ColStatus = 'added' | 'removed' | 'changed' | 'same'
export interface ColDiff {
  name: string
  status: ColStatus
  a?: SchemaColumn
  b?: SchemaColumn
  detail?: string
}

export type TableStatus = 'onlyA' | 'onlyB' | 'changed' | 'same'
export interface TableDiff {
  name: string
  status: TableStatus
  columns: ColDiff[]
}

const sig = (c: SchemaColumn): string =>
  `${c.type}|${c.nullable ? 'null' : 'notnull'}|${c.isPrimaryKey ? 'pk' : ''}`

/** Diff schema A against schema B. "added"/"onlyB" = present in B but not A. */
export function diffSchemas(a: SchemaSnapshot, b: SchemaSnapshot): TableDiff[] {
  const ma = new Map(a.map((t) => [t.name, t]))
  const mb = new Map(b.map((t) => [t.name, t]))
  const names = [...new Set([...ma.keys(), ...mb.keys()])].sort()
  const out: TableDiff[] = []

  for (const name of names) {
    const ta = ma.get(name)
    const tb = mb.get(name)
    if (ta && !tb) {
      out.push({ name, status: 'onlyA', columns: ta.columns.map((c) => ({ name: c.name, status: 'removed', a: c })) })
      continue
    }
    if (!ta && tb) {
      out.push({ name, status: 'onlyB', columns: tb.columns.map((c) => ({ name: c.name, status: 'added', b: c })) })
      continue
    }
    const ca = new Map(ta!.columns.map((c) => [c.name, c]))
    const cb = new Map(tb!.columns.map((c) => [c.name, c]))
    const colNames = [...new Set([...ca.keys(), ...cb.keys()])]
    const columns: ColDiff[] = colNames.map((cn) => {
      const x = ca.get(cn)
      const y = cb.get(cn)
      if (x && !y) return { name: cn, status: 'removed', a: x }
      if (!x && y) return { name: cn, status: 'added', b: y }
      if (sig(x!) === sig(y!)) return { name: cn, status: 'same', a: x, b: y }
      const d: string[] = []
      if (x!.type !== y!.type) d.push(`${x!.type} → ${y!.type}`)
      if (x!.nullable !== y!.nullable) d.push(x!.nullable ? 'nullable → not null' : 'not null → nullable')
      if (x!.isPrimaryKey !== y!.isPrimaryKey) d.push(x!.isPrimaryKey ? 'PK removed' : 'PK added')
      return { name: cn, status: 'changed', a: x, b: y, detail: d.join(', ') }
    })
    out.push({ name, status: columns.some((c) => c.status !== 'same') ? 'changed' : 'same', columns })
  }
  return out
}
