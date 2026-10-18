import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import type {
  Workspace,
  ConnectionConfig,
  Environment,
  NewProjectInput,
  Project,
  Topology,
  Catalog
} from '@shared/types'
import * as vault from './vault'

const SECRET_FIELDS = ['password', 'token', 'sshPassword', 'sshPassphrase'] as const

let storePath = ''
let catalog: Catalog = emptyCatalog()

function emptyCatalog(): Catalog {
  return { workspaces: [], projects: [] }
}

function file(): string {
  if (!storePath) storePath = join(app.getPath('userData'), 'datadock.json')
  return storePath
}

export function loadWorkspace(): void {
  if (vault.isConfigured()) {
    // Vault mode: the catalog lives inside the vault and arrives via adoptVault()
    // once it is unlocked. Until then there is nothing to show.
    catalog = vault.isUnlocked() ? vault.getPayload().catalog : emptyCatalog()
    return
  }
  const path = file()
  if (existsSync(path)) {
    try {
      catalog = JSON.parse(readFileSync(path, 'utf-8')) as Catalog
      if (!Array.isArray(catalog.projects)) catalog = emptyCatalog()
    } catch {
      catalog = emptyCatalog()
    }
  } else {
    catalog = emptyCatalog()
  }
  if (migrateWorkspaces()) persist()
}

/**
 * Workspaces written before the workspace level had projects at the root. Put
 * those under a "Default" workspace and make sure the active workspace is valid.
 * Returns true when anything changed.
 */
function migrateWorkspaces(): boolean {
  let changed = false
  if (!Array.isArray(catalog.workspaces)) {
    catalog.workspaces = []
    changed = true
  }
  const orphans = catalog.projects.filter(
    (p) => !p.workspaceId || !catalog.workspaces.some((c) => c.id === p.workspaceId)
  )
  if (orphans.length) {
    const home = defaultWorkspace()
    for (const p of orphans) p.workspaceId = home.id
    changed = true
  }
  const active = catalog.workspaces.find((c) => c.id === catalog.activeWorkspaceId)
  if (!active && catalog.workspaces.length) {
    catalog.activeWorkspaceId = catalog.workspaces[0].id
    changed = true
  }
  return changed
}

function persist(): void {
  if (vault.isConfigured()) {
    vault.save({ catalog })
    return
  }
  const path = file()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(catalog, null, 2), 'utf-8')
}

// ---- vault mode ---------------------------------------------------------------

/** Take over the catalog that was just decrypted from the vault. */
export function adoptVault(c: Catalog): void {
  catalog = c
  if (!Array.isArray(catalog.projects)) catalog = emptyCatalog()
  if (migrateWorkspaces()) persist()
}

/** Forget everything in memory (the vault was locked). */
export function reset(): void {
  catalog = emptyCatalog()
}

/**
 * A deep copy of the catalog with every connection secret decrypted, ready to
 * be sealed into a vault. Must run while the vault is not yet active, so the
 * safeStorage path of decryptSecret is still taken.
 */
export function exportForVault(): Catalog {
  const copy = JSON.parse(JSON.stringify(catalog)) as Catalog
  for (const p of copy.projects) {
    for (const e of p.environments) {
      for (const c of e.connections) {
        for (const f of SECRET_FIELDS) {
          const plain = decryptSecret(c[f])
          if (plain) c[f] = plain
          else delete c[f]
        }
      }
    }
  }
  return copy
}

/** Remove the plaintext catalog once its contents live in the vault. */
export function removePlaintextFile(): void {
  if (existsSync(file())) unlinkSync(file())
}

// ---- secret encryption -----------------------------------------------------

// Inside a vault, secrets are stored as-is: the vault key protects them, and a
// safeStorage-wrapped value would be bound to one machine's keychain.
function encryptSecret(plain: string): string {
  if (vault.isActive()) return plain
  if (!safeStorage.isEncryptionAvailable()) return `plain:${plain}`
  return `enc:${safeStorage.encryptString(plain).toString('base64')}`
}

function decryptSecret(stored: string | undefined): string | undefined {
  if (!stored) return undefined
  if (vault.isActive()) return stored
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

/** Strip secrets before handing the catalog to the renderer. */
export function catalogForRenderer(): Catalog {
  return {
    workspaces: catalog.workspaces.map((c) => ({ ...c })),
    activeWorkspaceId: catalog.activeWorkspaceId,
    projects: catalog.projects.map((p) => ({
      ...p,
      environments: p.environments.map((e) => ({
        ...e,
        connections: e.connections.map(sanitizeConnection)
      }))
    })),
    topologies: catalog.topologies ?? []
  }
}

/** Flat list of all stored connections (secrets stripped), across projects/envs. */
export function allConnections(): ConnectionConfig[] {
  const out: ConnectionConfig[] = []
  for (const p of catalog.projects) {
    for (const e of p.environments) {
      for (const c of e.connections) out.push(sanitizeConnection(c))
    }
  }
  return out
}

export interface ConnectionPath {
  workspace: string
  project: string
  environment: string
}

/** Where a connection lives, as display names: workspace / project / environment. */
export function connectionPath(id: string): ConnectionPath | undefined {
  for (const p of catalog.projects) {
    for (const e of p.environments) {
      if (e.connections.some((c) => c.id === id)) {
        const workspace = catalog.workspaces.find((c) => c.id === p.workspaceId)
        return { workspace: workspace?.name ?? '', project: p.name, environment: e.name }
      }
    }
  }
  return undefined
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
  for (const p of catalog.projects) {
    for (const e of p.environments) {
      const connection = e.connections.find((c) => c.id === id)
      if (connection) return { connection, environmentId: e.id }
    }
  }
  return undefined
}

// ---- workspaces --------------------------------------------------------------

/** The workspace projects land in when none was chosen; created on first use so
 * a catalog that never touches workspaces keeps working exactly as before. */
function defaultWorkspace(): Workspace {
  let home = catalog.workspaces.find((c) => c.name === 'Default')
  if (!home) {
    home = { id: randomUUID(), name: 'Default' }
    catalog.workspaces.unshift(home)
  }
  catalog.activeWorkspaceId ??= home.id
  return home
}

export function addWorkspace(name: string): Catalog {
  const workspace: Workspace = { id: randomUUID(), name: name.trim() || 'Untitled Workspace' }
  catalog.workspaces.push(workspace)
  catalog.activeWorkspaceId = workspace.id
  persist()
  return catalogForRenderer()
}

export function renameWorkspace(id: string, name: string): Catalog {
  const c = catalog.workspaces.find((x) => x.id === id)
  if (c) c.name = name.trim() || c.name
  persist()
  return catalogForRenderer()
}

/** Delete a workspace together with all of its projects. */
export function deleteWorkspace(id: string): Catalog {
  catalog.workspaces = catalog.workspaces.filter((c) => c.id !== id)
  catalog.projects = catalog.projects.filter((p) => p.workspaceId !== id)
  if (catalog.activeWorkspaceId === id) catalog.activeWorkspaceId = catalog.workspaces[0]?.id
  persist()
  return catalogForRenderer()
}

export function setActiveWorkspace(id: string): Catalog {
  if (catalog.workspaces.some((c) => c.id === id)) catalog.activeWorkspaceId = id
  persist()
  return catalogForRenderer()
}

export function moveProject(projectId: string, workspaceId: string): Catalog {
  const p = catalog.projects.find((x) => x.id === projectId)
  if (p && catalog.workspaces.some((c) => c.id === workspaceId)) p.workspaceId = workspaceId
  persist()
  return catalogForRenderer()
}

// ---- name matching (used by the importers) -----------------------------------

/** Project names compare without case, spaces or punctuation: "orbix-connector"
 * and "Orbix connector" are the same project. */
export function normalizeProjectName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function findProjectByName(workspaceId: string, name: string): Project | undefined {
  const key = normalizeProjectName(name)
  return catalog.projects.find((p) => p.workspaceId === workspaceId && normalizeProjectName(p.name) === key)
}

export function findEnvironmentByName(project: Project, name: string): Environment | undefined {
  const key = name.trim().toLowerCase()
  return project.environments.find((e) => e.name.trim().toLowerCase() === key)
}

export interface MergeProject {
  name: string
  environments: { name: string; connections: ConnectionConfig[] }[]
}

/**
 * Add connections to a workspace, reusing projects (normalised name) and
 * environments (case-insensitive) that already exist. Connections get fresh
 * ids; the caller has already decided which ones to add.
 */
export function mergeIntoWorkspace(workspaceId: string, projects: MergeProject[]): Catalog {
  if (!catalog.workspaces.some((w) => w.id === workspaceId)) throw new Error('Workspace not found')
  for (const incoming of projects) {
    let project = findProjectByName(workspaceId, incoming.name)
    if (!project) {
      project = { id: randomUUID(), name: incoming.name, workspaceId, environments: [] }
      catalog.projects.push(project)
    }
    for (const env of incoming.environments) {
      let environment = findEnvironmentByName(project, env.name)
      if (!environment) {
        environment = { id: randomUUID(), name: env.name, connections: [] }
        project.environments.push(environment)
      }
      for (const c of env.connections) environment.connections.push({ ...c, id: randomUUID() })
    }
  }
  persist()
  return catalogForRenderer()
}

// ---- mutations --------------------------------------------------------------

export function addProject(input: NewProjectInput): Catalog {
  const workspaceId = catalog.workspaces.some((c) => c.id === input.workspaceId)
    ? input.workspaceId
    : (catalog.activeWorkspaceId ?? defaultWorkspace().id)
  catalog.projects.push({
    id: randomUUID(),
    name: input.name.trim() || 'Untitled Project',
    workspaceId,
    environments: (input.environments ?? [])
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name) => ({ id: randomUUID(), name, connections: [] }))
  })
  persist()
  return catalogForRenderer()
}

export function renameProject(id: string, name: string): Catalog {
  const p = catalog.projects.find((x) => x.id === id)
  if (p) p.name = name.trim() || p.name
  persist()
  return catalogForRenderer()
}

export function deleteProject(id: string): Catalog {
  catalog.projects = catalog.projects.filter((p) => p.id !== id)
  persist()
  return catalogForRenderer()
}

// ---- replication topologies -------------------------------------------------

/** Create or update a topology (upsert by id; a blank id mints a new one). */
export function saveTopology(topology: Topology): Catalog {
  catalog.topologies ??= []
  const incoming: Topology = { ...topology, id: topology.id || randomUUID() }
  const idx = catalog.topologies.findIndex((t) => t.id === incoming.id)
  if (idx >= 0) catalog.topologies[idx] = incoming
  else catalog.topologies.push(incoming)
  persist()
  return catalogForRenderer()
}

export function deleteTopology(id: string): Catalog {
  catalog.topologies = (catalog.topologies ?? []).filter((t) => t.id !== id)
  persist()
  return catalogForRenderer()
}

export function addEnvironment(projectId: string, name: string): Catalog {
  const p = catalog.projects.find((x) => x.id === projectId)
  if (p) p.environments.push({ id: randomUUID(), name: name.trim() || 'New Environment', connections: [] })
  persist()
  return catalogForRenderer()
}

export function renameEnvironment(id: string, name: string): Catalog {
  for (const p of catalog.projects) {
    const e = p.environments.find((x) => x.id === id)
    if (e) e.name = name.trim() || e.name
  }
  persist()
  return catalogForRenderer()
}

export function deleteEnvironment(id: string): Catalog {
  for (const p of catalog.projects) {
    p.environments = p.environments.filter((e) => e.id !== id)
  }
  persist()
  return catalogForRenderer()
}

/** Create (if no id) or update a connection within an environment. */
export function saveConnection(environmentId: string, config: ConnectionConfig): Catalog {
  const env = catalog.projects.flatMap((p) => p.environments).find((e) => e.id === environmentId)
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
      const from = catalog.projects
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
  return catalogForRenderer()
}

export function deleteConnection(id: string): Catalog {
  for (const p of catalog.projects) {
    for (const e of p.environments) {
      e.connections = e.connections.filter((c) => c.id !== id)
    }
  }
  persist()
  return catalogForRenderer()
}

/** Duplicate an existing connection within the same environment. */
export function duplicateConnection(id: string): Catalog {
  const found = findConnection(id)
  if (!found) throw new Error('Connection not found')
  const env = catalog.projects
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
  return catalogForRenderer()
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
  const exportProject = (p: Project): unknown => ({
    name: p.name,
    environments: p.environments.map((e) => ({
      name: e.name,
      connections: e.connections.map((c) => {
        const clean: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(c)) if (!TRANSIENT.includes(k)) clean[k] = v
        return clean
      })
    }))
  })
  return {
    datadock: 'connections',
    version: 2,
    workspaces: catalog.workspaces.map((workspace) => ({
      name: workspace.name,
      color: workspace.color,
      projects: catalog.projects.filter((p) => p.workspaceId === workspace.id).map(exportProject)
    }))
  }
}

interface ImportProject {
  name?: string
  environments?: { name?: string; connections?: ConnectionConfig[] }[]
}

interface ImportWorkspace {
  name?: string
  color?: string
  projects?: ImportProject[]
}

/**
 * Merge an exported tree (new ids, no secrets) into the catalog. Version 2
 * files carry workspaces, which merge by name into existing ones; the older
 * project-only format lands in the active workspace.
 */
export function importConnections(data: {
  workspaces?: ImportWorkspace[]
  projects?: ImportProject[]
}): Catalog {
  const importInto = (workspaceId: string, projects: ImportProject[]): void => {
    for (const p of projects) {
      const project: Project = { id: randomUUID(), name: p.name || 'Imported', workspaceId, environments: [] }
      for (const e of p.environments ?? []) {
        project.environments.push({
          id: randomUUID(),
          name: e.name || 'Imported',
          connections: (e.connections ?? []).map((c) => ({ ...c, id: randomUUID() }))
        })
      }
      catalog.projects.push(project)
    }
  }

  for (const c of data.workspaces ?? []) {
    const name = c.name?.trim() || 'Imported'
    let workspace = catalog.workspaces.find((x) => x.name === name)
    if (!workspace) {
      workspace = { id: randomUUID(), name, color: c.color }
      catalog.workspaces.push(workspace)
    }
    importInto(workspace.id, c.projects ?? [])
  }

  if (data.projects?.length) {
    if (!catalog.activeWorkspaceId) {
      const workspace: Workspace = { id: randomUUID(), name: 'Imported' }
      catalog.workspaces.push(workspace)
      catalog.activeWorkspaceId = workspace.id
    }
    importInto(catalog.activeWorkspaceId, data.projects)
  }

  migrateWorkspaces()
  persist()
  return catalogForRenderer()
}
