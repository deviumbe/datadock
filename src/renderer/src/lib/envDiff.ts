// Comprehensive environment comparison: tables, columns, indexes and row counts
// between two connections (e.g. Production vs Staging).
import type { SchemaSnapshot, IndexDef, TableSizeInfo } from '@shared/types'
import { diffSchemas, type ColDiff } from './schemaDiff'

export interface IndexDiff {
  name: string
  status: 'added' | 'removed' | 'changed'
  a?: IndexDef
  b?: IndexDef
  detail?: string
}

export interface EnvTableDiff {
  name: string
  tableStatus: 'onlyA' | 'onlyB' | 'common'
  columnDiffs: ColDiff[] // non-identical columns only
  indexDiffs: IndexDiff[]
  rowsA: number | null
  rowsB: number | null
  rowsDiffer: boolean
  hasColumnDiff: boolean
  hasIndexDiff: boolean
  /** Any structural or data difference at all. */
  differs: boolean
}

const isig = (i: IndexDef): string => `${i.unique ? 'U:' : ''}${i.columns.join(',')}`

export function diffIndexes(a: IndexDef[], b: IndexDef[]): IndexDiff[] {
  const ma = new Map(a.map((i) => [i.name, i]))
  const mb = new Map(b.map((i) => [i.name, i]))
  const names = [...new Set([...ma.keys(), ...mb.keys()])].sort()
  const out: IndexDiff[] = []
  for (const n of names) {
    const x = ma.get(n)
    const y = mb.get(n)
    if (x && !y) out.push({ name: n, status: 'removed', a: x })
    else if (!x && y) out.push({ name: n, status: 'added', b: y })
    else if (x && y && isig(x) !== isig(y)) {
      const d: string[] = []
      if (x.unique !== y.unique) d.push(x.unique ? 'unique → non-unique' : 'non-unique → unique')
      if (x.columns.join(',') !== y.columns.join(','))
        d.push(`(${x.columns.join(', ')}) → (${y.columns.join(', ')})`)
      out.push({ name: n, status: 'changed', a: x, b: y, detail: d.join(', ') })
    }
  }
  return out
}

export function buildEnvDiff(
  snapA: SchemaSnapshot,
  snapB: SchemaSnapshot,
  sizesA: TableSizeInfo[],
  sizesB: TableSizeInfo[],
  indexesA: Record<string, IndexDef[]>,
  indexesB: Record<string, IndexDef[]>
): EnvTableDiff[] {
  const rowsAByName = new Map(sizesA.map((s) => [s.name, s.rows]))
  const rowsBByName = new Map(sizesB.map((s) => [s.name, s.rows]))

  return diffSchemas(snapA, snapB).map((td) => {
    const status = td.status === 'onlyA' ? 'onlyA' : td.status === 'onlyB' ? 'onlyB' : 'common'
    const columnDiffs = td.columns.filter((c) => c.status !== 'same')
    const indexDiffs = status === 'common' ? diffIndexes(indexesA[td.name] ?? [], indexesB[td.name] ?? []) : []
    const rowsA = rowsAByName.get(td.name) ?? null
    const rowsB = rowsBByName.get(td.name) ?? null
    const rowsDiffer = status === 'common' && rowsA != null && rowsB != null && rowsA !== rowsB
    return {
      name: td.name,
      tableStatus: status,
      columnDiffs,
      indexDiffs,
      rowsA,
      rowsB,
      rowsDiffer,
      hasColumnDiff: columnDiffs.length > 0,
      hasIndexDiff: indexDiffs.length > 0,
      differs: status !== 'common' || columnDiffs.length > 0 || indexDiffs.length > 0 || rowsDiffer
    }
  })
}
