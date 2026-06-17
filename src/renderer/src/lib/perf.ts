// Performance analytics derived from the query-history log.
import type { HistoryEntry } from '@shared/types'

/** One distinct query "shape" (literals stripped) with aggregated timings. */
export interface QueryStat {
  shape: string
  sample: string
  kind: string // SELECT / INSERT / UPDATE / ...
  count: number
  errorCount: number
  avgMs: number
  maxMs: number
  minMs: number
  totalMs: number
  lastRanAt: string
}

export interface TimeBucket {
  label: string
  start: number
  count: number
  avgMs: number
  errorCount: number
}

export interface IndexRec {
  table: string
  columns: string[]
  reason: string
  ddl: string
  queries: number
  avgMs: number
}

/** Collapse a statement to its parameterless shape so repeats group together. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?') // string literals
    .replace(/\b\d+(\.\d+)?\b/g, '?') // numbers
    .replace(/\bin\s*\(\s*(?:\?\s*,\s*)*\?\s*\)/gi, 'IN (?)') // IN (...) lists
    .replace(/\s+/g, ' ')
    .trim()
}

export function statementKind(sql: string): string {
  const m = sql.trim().match(/^\s*(\w+)/)
  return m ? m[1].toUpperCase() : '?'
}

/** Aggregate history entries into per-shape stats, newest activity first. */
export function aggregateQueries(entries: HistoryEntry[]): QueryStat[] {
  const map = new Map<string, QueryStat>()
  for (const e of entries) {
    const shape = normalizeSql(e.sql)
    if (!shape) continue
    let s = map.get(shape)
    if (!s) {
      s = {
        shape,
        sample: e.sql.trim(),
        kind: statementKind(e.sql),
        count: 0,
        errorCount: 0,
        avgMs: 0,
        maxMs: 0,
        minMs: Infinity,
        totalMs: 0,
        lastRanAt: e.ranAt
      }
      map.set(shape, s)
    }
    s.count++
    if (e.error) s.errorCount++
    const ms = e.durationMs ?? 0
    s.totalMs += ms
    s.maxMs = Math.max(s.maxMs, ms)
    s.minMs = Math.min(s.minMs, ms)
    if (e.ranAt > s.lastRanAt) s.lastRanAt = e.ranAt
  }
  const out = [...map.values()]
  for (const s of out) {
    s.avgMs = s.count ? s.totalMs / s.count : 0
    if (s.minMs === Infinity) s.minMs = 0
  }
  return out
}

/** Distribute entries across `buckets` equal time slices for the volume chart. */
export function timeBuckets(entries: HistoryEntry[], buckets = 24): TimeBucket[] {
  if (!entries.length) return []
  const times = entries.map((e) => new Date(e.ranAt).getTime()).filter((t) => !isNaN(t))
  if (!times.length) return []
  const min = Math.min(...times)
  const max = Math.max(...times)
  const size = Math.max((max - min) / buckets, 1)
  const out: TimeBucket[] = []
  const sums: number[] = []
  for (let i = 0; i < buckets; i++) {
    out.push({ label: '', start: min + i * size, count: 0, avgMs: 0, errorCount: 0 })
    sums.push(0)
  }
  for (const e of entries) {
    const t = new Date(e.ranAt).getTime()
    if (isNaN(t)) continue
    let idx = Math.floor((t - min) / size)
    if (idx >= buckets) idx = buckets - 1
    if (idx < 0) idx = 0
    out[idx].count++
    sums[idx] += e.durationMs ?? 0
    if (e.error) out[idx].errorCount++
  }
  const sameDay = max - min < 86_400_000
  for (let i = 0; i < buckets; i++) {
    out[i].avgMs = out[i].count ? sums[i] / out[i].count : 0
    const d = new Date(out[i].start)
    out[i].label = sameDay
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return out
}

const STOP_COLS = new Set(['and', 'or', 'not', 'null', 'is', 'true', 'false'])

/** Pull candidate filter/sort columns out of a single SELECT statement. */
function candidateColumns(sql: string): { from?: string; cols: string[] } {
  const lower = sql.toLowerCase()
  const fromMatch = sql.match(/\bfrom\s+["'`]?([a-z_][\w]*)["'`]?/i)
  const from = fromMatch?.[1]
  const cols = new Set<string>()
  // WHERE ... equality / comparison columns
  const whereMatch = lower.match(/\bwhere\b([\s\S]*?)(\bgroup\s+by\b|\border\s+by\b|\blimit\b|\bhaving\b|$)/)
  if (whereMatch) {
    const where = whereMatch[1]
    for (const m of where.matchAll(/([a-z_][\w]*)\s*(=|>|<|>=|<=|like|in\b)/g)) {
      if (!STOP_COLS.has(m[1])) cols.add(m[1])
    }
  }
  // JOIN ... ON col = col
  for (const m of lower.matchAll(/\bon\s+([a-z_][\w]*)\s*=/g)) {
    if (!STOP_COLS.has(m[1])) cols.add(m[1])
  }
  // ORDER BY columns
  const orderMatch = lower.match(/\border\s+by\s+([\s\S]*?)(\blimit\b|$)/)
  if (orderMatch) {
    for (const part of orderMatch[1].split(',')) {
      const c = part.trim().split(/\s+/)[0]
      if (c && /^[a-z_][\w]*$/.test(c) && !STOP_COLS.has(c)) cols.add(c)
    }
  }
  return { from, cols: [...cols] }
}

/**
 * Heuristic index suggestions: for slow SELECTs, propose single-column indexes
 * on filter/join/sort columns that aren't already the leading column of an
 * index (or a primary key). Best-effort — meant as hints, not gospel.
 */
export function recommendIndexes(
  stats: QueryStat[],
  thresholdMs: number,
  indexedLeadingCols: Record<string, Set<string>>
): IndexRec[] {
  const recs = new Map<string, IndexRec>()
  for (const s of stats) {
    if (s.kind !== 'SELECT' || s.avgMs < thresholdMs) continue
    const { from, cols } = candidateColumns(s.sample)
    if (!from || !cols.length) continue
    const covered = indexedLeadingCols[from] ?? indexedLeadingCols[from.toLowerCase()] ?? new Set()
    for (const col of cols) {
      if (covered.has(col) || covered.has(col.toLowerCase())) continue
      const key = `${from}.${col}`
      let r = recs.get(key)
      if (!r) {
        r = {
          table: from,
          columns: [col],
          reason: `Filtered/sorted on ${col} in a slow query`,
          ddl: `CREATE INDEX idx_${from}_${col} ON ${from} (${col});`,
          queries: 0,
          avgMs: 0
        }
        recs.set(key, r)
      }
      r.queries++
      r.avgMs = Math.max(r.avgMs, s.avgMs)
    }
  }
  return [...recs.values()].sort((a, b) => b.avgMs - a.avgMs)
}

export function fmtMs(ms: number): string {
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}
