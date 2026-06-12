import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import type { HistoryEntry } from '@shared/types'

const MAX = 500
let entries: HistoryEntry[] = []
let loaded = false
let path = ''

function file(): string {
  if (!path) path = join(app.getPath('userData'), 'history.json')
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

export function addHistory(entry: Omit<HistoryEntry, 'id' | 'ranAt'>): HistoryEntry {
  load()
  const full: HistoryEntry = { ...entry, id: randomUUID(), ranAt: new Date().toISOString() }
  entries.unshift(full)
  if (entries.length > MAX) entries = entries.slice(0, MAX)
  persist()
  return full
}

export function listHistory(): HistoryEntry[] {
  load()
  return entries
}

export function clearHistory(): void {
  entries = []
  persist()
}
