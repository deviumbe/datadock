import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

// Per-table notes / comments. Stored locally per connection in
// userData/notes/<connId>.json as { [tableName]: note }. No backend, no cloud.

function file(connId: string): string {
  return join(app.getPath('userData'), 'notes', `${connId}.json`)
}
function read(connId: string): Record<string, string> {
  try {
    const f = file(connId)
    if (!existsSync(f)) return {}
    const data = JSON.parse(readFileSync(f, 'utf-8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}
function write(connId: string, notes: Record<string, string>): void {
  const f = file(connId)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(notes, null, 2), 'utf-8')
}

export function listNotes(connId: string): Record<string, string> {
  return read(connId)
}

export function setNote(connId: string, table: string, text: string): Record<string, string> {
  const notes = read(connId)
  const t = text.trim()
  if (t) notes[table] = t
  else delete notes[table]
  write(connId, notes)
  return notes
}
