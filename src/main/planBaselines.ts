import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PlanBaseline } from '@shared/types'

// Per-connection query-plan baselines, kept in userData/plan-baselines.json as
// { [connId]: { [sigKey]: PlanBaseline } }. A baseline records the estimated
// top-node cost the first time a query's plan was viewed, so later views can
// flag a regression when the optimizer's estimate worsens.

type Store = Record<string, Record<string, PlanBaseline>>

function file(): string {
  return join(app.getPath('userData'), 'plan-baselines.json')
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
    writeFileSync(file(), JSON.stringify(store, null, 2), 'utf-8')
  } catch {
    /* best-effort */
  }
}

/** Collapse whitespace, drop a trailing semicolon, and lowercase for matching. */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim().toLowerCase()
}

export function getBaseline(connId: string, sql: string): PlanBaseline | null {
  return load()[connId]?.[normalize(sql)] ?? null
}

export function setBaseline(
  connId: string,
  sql: string,
  cost: number,
  rows?: number
): PlanBaseline {
  const store = load()
  const baseline: PlanBaseline = {
    sql: normalize(sql),
    cost,
    rows,
    savedAt: new Date().toISOString()
  }
  store[connId] = { ...(store[connId] ?? {}), [normalize(sql)]: baseline }
  persist(store)
  return baseline
}

export function removeBaseline(connId: string, sql: string): boolean {
  const store = load()
  const conn = store[connId]
  if (!conn || !(normalize(sql) in conn)) return false
  delete conn[normalize(sql)]
  persist(store)
  return true
}
