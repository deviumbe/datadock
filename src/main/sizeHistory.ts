import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import type { SizeSnapshot } from '@shared/types'

// Keep a bounded history of storage measurements per connection, at most one
// per calendar day, so the Performance dashboard can chart growth over time.
const MAX_PER_CONN = 180
let entries: SizeSnapshot[] = []
let loaded = false
let path = ''

function file(): string {
  if (!path) path = join(app.getPath('userData'), 'sizeHistory.json')
  return path
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (existsSync(file())) entries = JSON.parse(readFileSync(file(), 'utf-8'))
    if (!Array.isArray(entries)) entries = []
  } catch {
    entries = []
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(entries, null, 2), 'utf-8')
  } catch {
    /* best effort */
  }
}

const dayKey = (iso: string): string => iso.slice(0, 10)

/** Record a measurement, collapsing to one entry per connection per day. */
export function recordSize(
  connectionId: string,
  totalBytes: number,
  tableCount: number
): SizeSnapshot {
  load()
  const now = new Date().toISOString()
  const today = dayKey(now)
  // Replace today's existing measurement for this connection, if any.
  const idx = entries.findIndex(
    (e) => e.connectionId === connectionId && dayKey(e.at) === today
  )
  const snap: SizeSnapshot = { id: randomUUID(), connectionId, at: now, totalBytes, tableCount }
  if (idx >= 0) {
    entries[idx] = snap
  } else {
    entries.push(snap)
    // Trim oldest for this connection beyond the cap.
    const mine = entries.filter((e) => e.connectionId === connectionId)
    if (mine.length > MAX_PER_CONN) {
      const cutoff = mine[mine.length - MAX_PER_CONN].at
      entries = entries.filter((e) => e.connectionId !== connectionId || e.at >= cutoff)
    }
  }
  persist()
  return snap
}

export function listSizes(connectionId: string): SizeSnapshot[] {
  load()
  return entries
    .filter((e) => e.connectionId === connectionId)
    .sort((a, b) => a.at.localeCompare(b.at))
}
