import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import type { Snippet } from '@shared/types'

let snippets: Snippet[] = []
let loaded = false
let path = ''

function file(): string {
  if (!path) path = join(app.getPath('userData'), 'snippets.json')
  return path
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (existsSync(file())) snippets = JSON.parse(readFileSync(file(), 'utf-8'))
    if (!Array.isArray(snippets)) snippets = []
  } catch {
    snippets = []
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(snippets, null, 2), 'utf-8')
  } catch {
    /* best effort */
  }
}

export function listSnippets(): Snippet[] {
  load()
  return [...snippets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Create (no id) or update (existing id) a snippet. */
export function saveSnippet(input: Partial<Snippet> & { name: string; sql: string }): Snippet {
  load()
  const now = new Date().toISOString()
  const existing = input.id ? snippets.find((s) => s.id === input.id) : undefined
  if (existing) {
    Object.assign(existing, { name: input.name, sql: input.sql, description: input.description, updatedAt: now })
    persist()
    return existing
  }
  const snippet: Snippet = {
    id: randomUUID(),
    name: input.name,
    sql: input.sql,
    description: input.description,
    createdAt: now,
    updatedAt: now
  }
  snippets.push(snippet)
  persist()
  return snippet
}

export function removeSnippet(id: string): void {
  load()
  snippets = snippets.filter((s) => s.id !== id)
  persist()
}
