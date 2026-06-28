import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Snapshot, RestoreResult } from '@shared/types'
import { dumpDatabaseToFile, runSqlFile } from './io'

// Snapshots are full structure+data SQL dumps kept per connection under
// userData/snapshots/<connId>/. An index.json holds the metadata list.

function dir(connId: string): string {
  return join(app.getPath('userData'), 'snapshots', connId)
}
function indexFile(connId: string): string {
  return join(dir(connId), 'index.json')
}
function load(connId: string): Snapshot[] {
  try {
    const f = indexFile(connId)
    if (!existsSync(f)) return []
    const data = JSON.parse(readFileSync(f, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}
function persist(connId: string, list: Snapshot[]): void {
  mkdirSync(dir(connId), { recursive: true })
  writeFileSync(indexFile(connId), JSON.stringify(list, null, 2), 'utf-8')
}

export function listSnapshots(connId: string): Snapshot[] {
  return load(connId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function createSnapshot(connId: string, label: string): Promise<Snapshot> {
  const id = randomUUID()
  mkdirSync(dir(connId), { recursive: true })
  const file = join(dir(connId), `${id}.sql`)
  const { tableCount } = await dumpDatabaseToFile(connId, file, true)
  const snap: Snapshot = {
    id,
    connectionId: connId,
    label: label.trim() || 'Snapshot',
    createdAt: new Date().toISOString(),
    file,
    sizeBytes: statSync(file).size,
    tableCount
  }
  const list = load(connId)
  list.push(snap)
  persist(connId, list)
  return snap
}

export async function deleteSnapshot(connId: string, id: string): Promise<boolean> {
  const list = load(connId)
  const snap = list.find((s) => s.id === id)
  if (!snap) return false
  await unlink(snap.file).catch(() => undefined)
  persist(connId, list.filter((s) => s.id !== id))
  return true
}

/** Replay a snapshot's SQL (DROP + CREATE + INSERT) back onto the connection. */
export async function restoreSnapshot(connId: string, id: string): Promise<RestoreResult> {
  const snap = load(connId).find((s) => s.id === id)
  if (!snap) return { statements: 0, errors: ['Snapshot not found.'] }
  if (!existsSync(snap.file)) return { statements: 0, errors: ['Snapshot file is missing.'] }
  const r = await runSqlFile(connId, snap.file)
  return { statements: r.statements ?? 0, errors: r.errors ?? [] }
}
