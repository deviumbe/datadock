import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { RowVersion, RowVersionInput } from '@shared/types'

// A local journal of every row change committed through DataDock's editor,
// kept in userData/row-history.json as { [connId]: RowVersion[] } (newest last).
// This powers the per-row time-travel view without touching the database schema.
// Only edits made *in DataDock* are recorded — external writes aren't visible.

const CAP = 5000 // versions retained per connection (oldest pruned)

type Store = Record<string, RowVersion[]>

function file(): string {
  return join(app.getPath('userData'), 'row-history.json')
}
function load(): Store {
  try {
    const f = file()
    if (!existsSync(f)) return {}
    const data = JSON.parse(readFileSync(f, 'utf-8'))
    return data && typeof data === 'object' ? (data as Store) : {}
  } catch {
    return {}
  }
}
function persist(store: Store): void {
  try {
    writeFileSync(file(), JSON.stringify(store), 'utf-8')
  } catch {
    /* best-effort */
  }
}

/** Stable identity for a row, independent of column order. */
export function pkKeyOf(pk: Record<string, unknown>): string {
  return Object.keys(pk)
    .sort()
    .map((k) => `${k}=${pk[k] === null || pk[k] === undefined ? '∅' : String(pk[k])}`)
    .join('&')
}

export function record(connId: string, entries: RowVersionInput[]): void {
  if (!entries.length) return
  const store = load()
  const list = store[connId] ?? []
  const now = new Date().toISOString()
  for (const e of entries) {
    list.push({
      id: randomUUID(),
      connectionId: connId,
      table: e.table,
      pkKey: pkKeyOf(e.pk),
      pk: e.pk,
      op: e.op,
      before: e.before,
      after: e.after,
      at: now
    })
  }
  store[connId] = list.length > CAP ? list.slice(list.length - CAP) : list
  persist(store)
}

/** All recorded versions for one row, newest first. */
export function list(connId: string, table: string, pk: Record<string, unknown>): RowVersion[] {
  const key = pkKeyOf(pk)
  return load()
    [connId]?.filter((v) => v.table === table && v.pkKey === key)
    .sort((a, b) => b.at.localeCompare(a.at)) ?? []
}

/** Drop history for a connection (optionally a single table). */
export function clear(connId: string, table?: string): void {
  const store = load()
  if (!store[connId]) return
  if (table) store[connId] = store[connId].filter((v) => v.table !== table)
  else delete store[connId]
  persist(store)
}
