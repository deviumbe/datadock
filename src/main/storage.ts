import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import type { ConnectionConfig, Project, Workspace } from '@shared/types'

const SECRET_FIELDS = ['password', 'token', 'sshPassword', 'sshPassphrase'] as const

let storePath = ''
let workspace: Workspace = { projects: [] }

function file(): string {
  if (!storePath) storePath = join(app.getPath('userData'), 'datadock.json')
  return storePath
}

export function loadWorkspace(): void {
  const path = file()
  if (existsSync(path)) {
    try {
      workspace = JSON.parse(readFileSync(path, 'utf-8')) as Workspace
      if (!Array.isArray(workspace.projects)) workspace = { projects: [] }
    } catch {
      workspace = { projects: [] }
    }
  } else {
    workspace = { projects: [] }
  }
}

function persist(): void {
  const path = file()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(workspace, null, 2), 'utf-8')
}

// ---- secret encryption -----------------------------------------------------

function encryptSecret(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) return `plain:${plain}`
  return `enc:${safeStorage.encryptString(plain).toString('base64')}`
}

function decryptSecret(stored: string | undefined): string | undefined {
  if (!stored) return undefined
  if (stored.startsWith('plain:')) return stored.slice(6)
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch {
      // Key mismatch (e.g. the OS keychain key changed) — don't crash; the
      // secret is unrecoverable and must be re-entered by the user.
      return undefined
    }
  }
  return stored
}

// ---- views ------------------------------------------------------------------

/** Strip secrets before handing the workspace to the renderer. */
export function workspaceForRenderer(): Workspace {
  return {
    projects: workspace.projects.map((p) => ({
      ...p,
      environments: p.environments.map((e) => ({
        ...e,
        connections: e.connections.map(sanitizeConnection)
      }))
    }))
  }
}

/** Flat list of all stored connections (secrets stripped), across projects/envs. */
export function allConnections(): ConnectionConfig[] {
  const out: ConnectionConfig[] = []
  for (const p of workspace.projects) {
    for (const e of p.environments) {
      for (const c of e.connections) out.push(sanitizeConnection(c))
    }
  }
  return out
}

function sanitizeConnection(c: ConnectionConfig): ConnectionConfig {
  const clone: ConnectionConfig = { ...c }
  clone.hasPassword = !!c.password
  clone.hasToken = !!c.token
  clone.hasSshPassword = !!c.sshPassword
  clone.hasSshPassphrase = !!c.sshPassphrase
  delete clone.password
  delete clone.token
  delete clone.sshPassword
  delete clone.sshPassphrase
  return clone
}

/** Resolve a stored connection with decrypted secrets, for the driver layer. */
export function resolveConnection(id: string): ConnectionConfig {
  const found = findConnection(id)
  if (!found) throw new Error('Connection not found')
  const c = { ...found.connection }
  for (const f of SECRET_FIELDS) {
    if (c[f]) c[f] = decryptSecret(c[f] as string)
  }
  return c
}

/**
 * Resolve secrets for a config coming from the renderer form. If a secret field
 * is blank but the connection already exists, keep the stored (encrypted) value.
 */
export function resolveFormConfig(config: ConnectionConfig): ConnectionConfig {
  const resolved: ConnectionConfig = { ...config }
  const existing = config.id ? findConnection(config.id)?.connection : undefined
  for (const f of SECRET_FIELDS) {
    if (!resolved[f] && existing?.[f]) {
      resolved[f] = decryptSecret(existing[f] as string)
    }
  }
  return resolved
}

// ---- lookups ----------------------------------------------------------------

function findConnection(
  id: string
): { connection: ConnectionConfig; environmentId: string } | undefined {
  for (const p of workspace.projects) {
    for (const e of p.environments) {
      const connection = e.connections.find((c) => c.id === id)
      if (connection) return { connection, environmentId: e.id }
    }
  }
  return undefined
}

// ---- mutations --------------------------------------------------------------

export function addProject(name: string): Workspace {
  workspace.projects.push({ id: randomUUID(), name: name.trim() || 'Untitled Project', environments: [] })
  persist()
  return workspaceForRenderer()
}

export function renameProject(id: string, name: string): Workspace {
  const p = workspace.projects.find((x) => x.id === id)
  if (p) p.name = name.trim() || p.name
  persist()
  return workspaceForRenderer()
}

export function deleteProject(id: string): Workspace {
  workspace.projects = workspace.projects.filter((p) => p.id !== id)
  persist()
  return workspaceForRenderer()
}

export function addEnvironment(projectId: string, name: string): Workspace {
  const p = workspace.projects.find((x) => x.id === projectId)
  if (p) p.environments.push({ id: randomUUID(), name: name.trim() || 'New Environment', connections: [] })
  persist()
  return workspaceForRenderer()
}

export function renameEnvironment(id: string, name: string): Workspace {
  for (const p of workspace.projects) {
    const e = p.environments.find((x) => x.id === id)
    if (e) e.name = name.trim() || e.name
  }
  persist()
  return workspaceForRenderer()
}

export function deleteEnvironment(id: string): Workspace {
  for (const p of workspace.projects) {
    p.environments = p.environments.filter((e) => e.id !== id)
  }
  persist()
  return workspaceForRenderer()
}

/** Create (if no id) or update a connection within an environment. */
export function saveConnection(environmentId: string, config: ConnectionConfig): Workspace {
  const env = workspace.projects.flatMap((p) => p.environments).find((e) => e.id === environmentId)
  if (!env) throw new Error('Environment not found')

  const prepared: ConnectionConfig = { ...config }
  delete prepared.hasPassword
  delete prepared.hasToken
  delete prepared.hasSshPassword
  delete prepared.hasSshPassphrase

  const existing = config.id ? findConnection(config.id)?.connection : undefined

  for (const f of SECRET_FIELDS) {
    const incoming = prepared[f] as string | undefined
    if (incoming) {
      prepared[f] = encryptSecret(incoming)
    } else if (existing?.[f]) {
      prepared[f] = existing[f] // keep prior encrypted secret
    } else {
      delete prepared[f]
    }
  }

  if (existing) {
    Object.assign(existing, prepared, { id: existing.id })
    // If the connection moved environments, relocate it.
    const current = findConnection(existing.id)
    if (current && current.environmentId !== environmentId) {
      const from = workspace.projects
        .flatMap((p) => p.environments)
        .find((e) => e.id === current.environmentId)
      if (from) from.connections = from.connections.filter((c) => c.id !== existing.id)
      env.connections.push(existing)
    }
  } else {
    prepared.id = randomUUID()
    env.connections.push(prepared)
  }

  persist()
  return workspaceForRenderer()
}

export function deleteConnection(id: string): Workspace {
  for (const p of workspace.projects) {
    for (const e of p.environments) {
      e.connections = e.connections.filter((c) => c.id !== id)
    }
  }
  persist()
  return workspaceForRenderer()
}

/** Duplicate an existing connection within the same environment. */
export function duplicateConnection(id: string): Workspace {
  const found = findConnection(id)
  if (!found) throw new Error('Connection not found')
  const env = workspace.projects
    .flatMap((p) => p.environments)
    .find((e) => e.id === found.environmentId)
  if (!env) throw new Error('Environment not found')
  const clone: ConnectionConfig = {
    ...found.connection,
    id: randomUUID(),
    name: `${found.connection.name} (copy)`
  }
  env.connections.push(clone)
  persist()
  return workspaceForRenderer()
}

// ---- share: export / import connection definitions (no secrets) -------------

const TRANSIENT = [
  'id',
  'password',
  'token',
  'sshPassword',
  'sshPassphrase',
  'hasPassword',
  'hasToken',
  'hasSshPassword',
  'hasSshPassphrase'
]

/** Cleaned, secret-free, id-free tree suitable for sharing. */
export function connectionsForExport(): unknown {
  return {
    datadock: 'connections',
    version: 1,
    projects: workspace.projects.map((p) => ({
      name: p.name,
      environments: p.environments.map((e) => ({
        name: e.name,
        connections: e.connections.map((c) => {
          const clean: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(c)) if (!TRANSIENT.includes(k)) clean[k] = v
          return clean
        })
      }))
    }))
  }
}

interface ImportProject {
  name?: string
  environments?: { name?: string; connections?: ConnectionConfig[] }[]
}

/** Merge imported projects (new ids, no secrets) into the workspace. */
export function importConnections(data: { projects?: ImportProject[] }): Workspace {
  for (const p of data.projects ?? []) {
    const project: Project = { id: randomUUID(), name: p.name || 'Imported', environments: [] }
    for (const e of p.environments ?? []) {
      project.environments.push({
        id: randomUUID(),
        name: e.name || 'Imported',
        connections: (e.connections ?? []).map((c) => ({ ...c, id: randomUUID() }))
      })
    }
    workspace.projects.push(project)
  }
  persist()
  return workspaceForRenderer()
}
