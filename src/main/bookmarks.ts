import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import type { Bookmark } from '@shared/types'

// Per-connection query bookmarks. Stored locally per connection in
// userData/bookmarks/<connId>.json. No backend, no cloud.

function file(connId: string): string {
  return join(app.getPath('userData'), 'bookmarks', `${connId}.json`)
}
function read(connId: string): Bookmark[] {
  try {
    const f = file(connId)
    if (!existsSync(f)) return []
    const data = JSON.parse(readFileSync(f, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}
function write(connId: string, list: Bookmark[]): void {
  const f = file(connId)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(list, null, 2), 'utf-8')
}

export function listBookmarks(connId: string): Bookmark[] {
  return read(connId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function saveBookmark(connId: string, name: string, sql: string): Bookmark {
  const list = read(connId)
  const bm: Bookmark = {
    id: randomUUID(),
    connectionId: connId,
    name: name.trim() || 'Untitled',
    sql,
    createdAt: new Date().toISOString()
  }
  list.push(bm)
  write(connId, list)
  return bm
}

export function removeBookmark(connId: string, id: string): boolean {
  const list = read(connId)
  if (!list.some((b) => b.id === id)) return false
  write(connId, list.filter((b) => b.id !== id))
  return true
}
