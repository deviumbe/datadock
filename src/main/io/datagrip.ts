import { dialog } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join } from 'path'
import type {
  ConnectionConfig,
  DataGripImportResult,
  DataGripPlannedConnection,
  DataGripPlannedProject,
  DataGripPreview,
  DataGripSshProfilePlan,
  DriverType,
  SshAuthMethod,
  SshProfile
} from '@shared/types'
import { DRIVERS } from '@shared/types'
import * as store from '../storage'
import * as settings from '../settings'

// Imports a DataGrip project (its .idea/dataSources.xml and friends) into a
// DataDock workspace. DataGrip keeps passwords in the OS keychain under its
// own key, so those are never available here; everything else is.

// ---- a small XML reader -----------------------------------------------------
// The JetBrains files are plain elements, attributes and text. This covers
// exactly that (plus comments, CDATA and the prolog) without a dependency.

interface XmlNode {
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '')
  return attrs
}

function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: '', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) break
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt))
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt)
      i = end < 0 ? src.length : end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt)
      stack[stack.length - 1].text += src.slice(lt + 9, end < 0 ? src.length : end)
      i = end < 0 ? src.length : end + 3
      continue
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt)
      i = end < 0 ? src.length : end + 1
      continue
    }
    const gt = src.indexOf('>', lt)
    if (gt < 0) break
    const body = src.slice(lt + 1, gt)
    i = gt + 1
    if (body.startsWith('/')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const selfClosing = body.endsWith('/')
    const inner = selfClosing ? body.slice(0, -1) : body
    const space = inner.search(/\s/)
    const node: XmlNode = {
      tag: space < 0 ? inner : inner.slice(0, space),
      attrs: space < 0 ? {} : parseAttrs(inner.slice(space)),
      children: [],
      text: ''
    }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return root
}

function* walk(node: XmlNode, tag: string): Generator<XmlNode> {
  for (const c of node.children) {
    if (c.tag === tag) yield c
    yield* walk(c, tag)
  }
}

function child(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag)
}

function childText(node: XmlNode, tag: string): string {
  return child(node, tag)?.text.trim() ?? ''
}

function readXml(path: string): XmlNode {
  return parseXml(readFileSync(path, 'utf-8'))
}

// ---- DataGrip files ---------------------------------------------------------

interface DgSource {
  uuid: string
  name: string
  group: string
  driverRef: string
  url: string
  user: string
  sshConfigId?: string
}

interface DgSshConfig {
  id: string
  host: string
  port: number
  user: string
  keyPath?: string
  authType: string
  label: string
}

interface DgProject {
  folder: string
  ideaDir: string
  projectDir: string
  sources: DgSource[]
  sshConfigs: Map<string, DgSshConfig>
  hasLocalFile: boolean
  hasSshFile: boolean
}

function locateIdeaDir(folder: string): string {
  const candidates = [join(folder, '.idea'), folder]
  const found = candidates.find((dir) => existsSync(join(dir, 'dataSources.xml')))
  if (!found) {
    throw new Error(`No DataGrip project found: ${folder} has no .idea/dataSources.xml`)
  }
  return found
}

function expandMacros(value: string, projectDir: string): string {
  return value
    .replaceAll('$USER_HOME$', homedir())
    .replaceAll('$PROJECT_DIR$', projectDir)
    .replaceAll('$ProjectFileDir$', projectDir)
}

/** JetBrains config roots that hold the per-release DataGrip options folders. */
function jetBrainsConfigRoots(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') return [join(home, 'Library', 'Application Support', 'JetBrains')]
  if (process.platform === 'win32') {
    return [join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'JetBrains')]
  }
  return [join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'JetBrains')]
}

function versionOf(name: string): number {
  const m = /(\d{4})\.(\d+)/.exec(name)
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0
}

/** Every DataGrip sshConfigs.xml on this machine, newest release first. */
function dataGripSshConfigFiles(): string[] {
  const files: { path: string; version: number }[] = []
  for (const root of jetBrainsConfigRoots()) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      if (!/^datagrip/i.test(entry)) continue
      const path = join(root, entry, 'options', 'sshConfigs.xml')
      if (existsSync(path)) files.push({ path, version: versionOf(entry) })
    }
  }
  return files.sort((a, b) => b.version - a.version).map((f) => f.path)
}

function readSshConfigs(ideaDir: string, projectDir: string): { configs: Map<string, DgSshConfig>; found: boolean } {
  const configs = new Map<string, DgSshConfig>()
  const files = [join(ideaDir, 'sshConfigs.xml'), ...dataGripSshConfigFiles()].filter(existsSync)
  for (const file of files) {
    for (const node of walk(readXml(file), 'sshConfig')) {
      const id = node.attrs.id
      if (!id || configs.has(id)) continue
      const host = node.attrs.host ?? ''
      const user = node.attrs.username ?? ''
      const keyPath = node.attrs.keyPath ? expandMacros(node.attrs.keyPath, projectDir) : undefined
      configs.set(id, {
        id,
        host,
        port: Number(node.attrs.port) || 22,
        user,
        keyPath,
        authType: node.attrs.authType ?? '',
        label: node.attrs.customName || `${user}@${host}`
      })
    }
  }
  return { configs, found: files.length > 0 }
}

function readProject(folder: string): DgProject {
  const ideaDir = locateIdeaDir(folder)
  const projectDir = basename(ideaDir) === '.idea' ? dirname(ideaDir) : ideaDir

  const local = new Map<string, { user: string; sshConfigId?: string }>()
  const localFile = join(ideaDir, 'dataSources.local.xml')
  const hasLocalFile = existsSync(localFile)
  if (hasLocalFile) {
    for (const node of walk(readXml(localFile), 'data-source')) {
      const ssh = child(node, 'ssh-properties')
      const enabled = ssh ? childText(ssh, 'enabled') === 'true' : false
      local.set(node.attrs.uuid ?? '', {
        user: childText(node, 'user-name'),
        sshConfigId: enabled ? childText(ssh!, 'ssh-config-id') || undefined : undefined
      })
    }
  }

  const sources: DgSource[] = []
  for (const node of walk(readXml(join(ideaDir, 'dataSources.xml')), 'data-source')) {
    const uuid = node.attrs.uuid ?? ''
    const l = local.get(uuid)
    sources.push({
      uuid,
      name: node.attrs.name ?? '',
      group: node.attrs.group ?? '',
      driverRef: childText(node, 'driver-ref'),
      url: expandMacros(childText(node, 'jdbc-url'), projectDir),
      user: l?.user ?? '',
      sshConfigId: l?.sshConfigId
    })
  }

  const ssh = readSshConfigs(ideaDir, projectDir)
  return {
    folder,
    ideaDir,
    projectDir,
    sources,
    sshConfigs: ssh.configs,
    hasLocalFile,
    hasSshFile: ssh.found
  }
}

// ---- mapping rules ----------------------------------------------------------

const LOCAL_PROJECT = 'Local servers'

const ENV_WORDS: Record<string, string> = {
  prod: 'Production',
  production: 'Production',
  staging: 'Staging',
  stage: 'Staging',
  test: 'Test',
  testing: 'Test',
  'test-beta': 'Test',
  local: 'Local',
  dev: 'Development',
  development: 'Development',
  alpha: 'Alpha',
  acc: 'Acceptance',
  acceptance: 'Acceptance',
  uat: 'Acceptance',
  qa: 'QA'
}

const ENV_COLOR: Record<string, string> = {
  Production: '#e5616a',
  Staging: '#1fb6a6',
  Test: '#5b8def',
  Local: '#3fcf8e',
  Development: '#e0a14a',
  Alpha: '#9b7ede'
}
const DEFAULT_COLOR = '#888f9c'

function envWord(token: string): string | undefined {
  return ENV_WORDS[token.toLowerCase()]
}

/** "Production - Client" and "Production/Shared" both say Production. */
function groupEnvironment(group: string): string | undefined {
  const first = group.split(' - ')[0].split('/')[0].trim()
  return first ? envWord(first) : undefined
}

function prettyProject(token: string): string {
  if (token.includes('.')) return token
  const t = token.replace(/[-_]+/g, ' ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function isLocalHost(host: string | undefined): boolean {
  return !host || ['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase())
}

/**
 * Where a data source lands. DataGrip names of the form "env@project" split
 * into project + environment; the group can override the environment and a
 * "Local…" group collects everything under one project of local servers.
 */
function place(
  name: string,
  group: string,
  endpoint: Endpoint,
  tunnelled: boolean
): { project: string; environment: string } {
  if (group.toLowerCase().startsWith('local')) return { project: LOCAL_PROJECT, environment: 'Local' }
  const at = name.indexOf('@')
  if (at < 0) {
    // "ampp prod" / "prod ampp": an environment word at either end still counts.
    const words = name.split(/\s+/).filter(Boolean)
    if (words.length > 1 && envWord(words[words.length - 1])) {
      return { project: prettyProject(words.slice(0, -1).join(' ')), environment: envWord(words[words.length - 1])! }
    }
    if (words.length > 1 && envWord(words[0])) {
      return { project: prettyProject(words.slice(1).join(' ')), environment: envWord(words[0])! }
    }
    const local = !tunnelled && (isLocalHost(endpoint.host) || !!endpoint.filePath)
    return { project: prettyProject(name), environment: groupEnvironment(group) ?? (local ? 'Local' : 'Default') }
  }
  let prefix = name.slice(0, at).trim()
  let token = name.slice(at + 1).trim()
  if (!token) return { project: LOCAL_PROJECT, environment: 'Local' }
  if (envWord(token) && !envWord(prefix)) [prefix, token] = [token, prefix]
  const environment =
    groupEnvironment(group) ?? envWord(prefix) ?? (prefix ? prettyProject(prefix) : 'Local')
  return { project: prettyProject(token), environment }
}

function mapDriver(driverRef: string, url: string): DriverType | undefined {
  const ref = driverRef.toLowerCase()
  const u = url.toLowerCase()
  const is = (refPrefix: string, ...schemes: string[]): boolean =>
    ref.startsWith(refPrefix) || schemes.some((s) => u.startsWith(s))
  if (is('mysql', 'jdbc:mysql:') || is('mariadb', 'jdbc:mariadb:')) return 'mysql'
  if (is('postgres', 'jdbc:postgresql:')) return 'postgres'
  if (is('sqlite', 'jdbc:sqlite:')) return 'sqlite'
  if (is('sqlserver', 'jdbc:sqlserver:')) return 'mssql'
  if (is('oracle', 'jdbc:oracle:')) return 'oracle'
  if (is('redis', 'jdbc:redis:')) return 'redis'
  if (is('mongo', 'mongodb://', 'mongodb+srv://', 'jdbc:mongodb')) return 'mongodb'
  return undefined
}

function defaultPort(driver: DriverType): number | undefined {
  return DRIVERS.find((d) => d.type === driver)?.defaultPort
}

interface Endpoint {
  host?: string
  port?: number
  database?: string
  filePath?: string
  url?: string
  warnings: string[]
}

function parseHostUrl(driver: DriverType, url: string): Endpoint {
  const u = new URL(url.replace(/^jdbc:/i, ''))
  const path = decodeURIComponent(u.pathname.replace(/^\//, ''))
  return {
    host: u.hostname.replace(/^\[|\]$/g, '') || 'localhost',
    port: u.port ? Number(u.port) : defaultPort(driver),
    database: path || undefined,
    warnings: []
  }
}

function parseSqlServerUrl(url: string): Endpoint {
  const rest = url.replace(/^jdbc:sqlserver:\/\//i, '')
  const [server, ...props] = rest.split(';')
  const options: Record<string, string> = {}
  for (const p of props) {
    const eq = p.indexOf('=')
    if (eq > 0) options[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim()
  }
  const [hostPart, portPart] = server.split(':')
  const [host, instance] = (hostPart || options.servername || 'localhost').split('\\')
  const warnings: string[] = []
  if (instance) warnings.push(`Named instance "${instance}" is not carried over; set the port instead`)
  return {
    host,
    port: Number(portPart || options.port) || 1433,
    database: options.databasename || options.database || undefined,
    warnings
  }
}

function parseOracleUrl(url: string): Endpoint {
  const m = /^jdbc:oracle:[^@]*@(?:\/\/)?([^:/(]+)(?::(\d+))?(?:([/:])([^?]+))?/i.exec(url)
  if (!m || url.includes('(DESCRIPTION')) {
    throw new Error('Oracle TNS descriptors are not supported; only host:port/service URLs')
  }
  const warnings: string[] = []
  if (m[3] === ':') warnings.push('SID-style URL; DataDock connects with a service name')
  return {
    host: m[1],
    port: m[2] ? Number(m[2]) : 1521,
    database: m[4] || undefined,
    warnings
  }
}

function parseSqliteUrl(url: string, projectDir: string): Endpoint {
  let path = url.replace(/^jdbc:sqlite:/i, '').split('?')[0].trim()
  if (!path || path === ':memory:') throw new Error('In-memory SQLite database')
  if (path.startsWith('file:')) path = path.slice(5)
  if (!isAbsolute(path)) path = join(projectDir, path)
  return { filePath: path, warnings: [] }
}

function parseMongoUrl(url: string): Endpoint {
  const uri = url.replace(/^jdbc:/i, '')
  const u = new URL(uri)
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined
  return { url: uri, database, warnings: [] }
}

function parseEndpoint(driver: DriverType, url: string, projectDir: string): Endpoint {
  if (!url) throw new Error('No JDBC URL')
  switch (driver) {
    case 'sqlite':
      return parseSqliteUrl(url, projectDir)
    case 'mssql':
      return parseSqlServerUrl(url)
    case 'oracle':
      return parseOracleUrl(url)
    case 'mongodb':
      return parseMongoUrl(url)
    default:
      return parseHostUrl(driver, url)
  }
}

// ---- planning ---------------------------------------------------------------

interface PlannedItem {
  sourceId: string
  config: ConnectionConfig
  sshConfigId?: string
  status: DataGripPlannedConnection['status']
  duplicateOf?: string
  warnings: string[]
}

interface PlannedEnvironment {
  name: string
  exists: boolean
  items: PlannedItem[]
}

interface PlannedProject {
  name: string
  exists: boolean
  environments: PlannedEnvironment[]
}

interface Plan {
  project: DgProject
  workspaceId: string
  projects: PlannedProject[]
  skipped: { name: string; reason: string }[]
  /** The DataGrip SSH configs referenced by new connections, with the DataDock
   * profile that already matches them (by host + user) when there is one. */
  sshConfigs: { config: DgSshConfig; existing?: SshProfile }[]
  notes: string[]
}

function sshAuthMethod(config: DgSshConfig): SshAuthMethod {
  if (config.authType === 'PASSWORD') return 'password'
  if (config.authType === 'OPEN_SSH') return 'agent'
  return 'key'
}

function findSshProfile(config: DgSshConfig, profiles: SshProfile[]): SshProfile | undefined {
  return profiles.find(
    (p) => p.host.toLowerCase() === config.host.toLowerCase() && p.user === config.user
  )
}

/** Two configs reach the same database: same file, or same database name on
 * the same port (hosts differ freely because tunnelled ones all say localhost).
 * Without a database name only an identical name + host + port counts, so a
 * re-import of the same project stays a no-op. */
function sameDatabase(a: ConnectionConfig, b: ConnectionConfig): boolean {
  if (a.filePath || b.filePath) return !!a.filePath && a.filePath === b.filePath
  const samePort = (a.port ?? defaultPort(a.driver)) === (b.port ?? defaultPort(b.driver))
  if (!a.database || !b.database) {
    return !a.database && !b.database && a.name === b.name && a.host === b.host && samePort
  }
  return a.database === b.database && samePort
}

function buildPlan(folder: string, workspaceId: string): Plan {
  const project = readProject(folder)
  const profiles = settings.getSettings().sshProfiles
  const plan: Plan = { project, workspaceId, projects: [], skipped: [], sshConfigs: [], notes: [] }
  const referencedSsh = new Map<string, DgSshConfig>()

  const projectFor = (name: string): PlannedProject => {
    const key = store.normalizeProjectName(name)
    let planned = plan.projects.find((p) => store.normalizeProjectName(p.name) === key)
    if (!planned) {
      const existing = store.findProjectByName(workspaceId, name)
      planned = { name: existing?.name ?? name, exists: !!existing, environments: [] }
      plan.projects.push(planned)
    }
    return planned
  }
  const environmentFor = (planned: PlannedProject, name: string): PlannedEnvironment => {
    let env = planned.environments.find((e) => e.name.toLowerCase() === name.toLowerCase())
    if (!env) {
      const existingProject = store.findProjectByName(workspaceId, planned.name)
      const existing = existingProject ? store.findEnvironmentByName(existingProject, name) : undefined
      env = { name: existing?.name ?? name, exists: !!existing, items: [] }
      planned.environments.push(env)
    }
    return env
  }
  const existingConnections = (planned: PlannedProject, env: PlannedEnvironment): ConnectionConfig[] => {
    const p = store.findProjectByName(workspaceId, planned.name)
    const e = p ? store.findEnvironmentByName(p, env.name) : undefined
    return e?.connections ?? []
  }

  for (const source of project.sources) {
    const driver = mapDriver(source.driverRef, source.url)
    if (!driver) {
      plan.skipped.push({ name: source.name, reason: `Unsupported driver "${source.driverRef || '?'}"` })
      continue
    }
    let endpoint: Endpoint
    try {
      endpoint = parseEndpoint(driver, source.url, project.projectDir)
    } catch (err) {
      plan.skipped.push({ name: source.name, reason: (err as Error).message })
      continue
    }

    const tunnelled = !!source.sshConfigId && project.sshConfigs.has(source.sshConfigId)
    const { project: projectName, environment: envName } = place(source.name, source.group, endpoint, tunnelled)
    const planned = projectFor(projectName)
    const env = environmentFor(planned, envName)

    const config: ConnectionConfig = {
      id: '',
      name: source.name,
      driver,
      color: ENV_COLOR[envName] ?? DEFAULT_COLOR,
      host: endpoint.host,
      port: endpoint.port,
      database: endpoint.database,
      filePath: endpoint.filePath,
      url: endpoint.url,
      user: source.user || undefined
    }
    if (envName === 'Production') config.production = true
    for (const key of Object.keys(config) as (keyof ConnectionConfig)[]) {
      if (config[key] === undefined) delete config[key]
    }

    const warnings = [...endpoint.warnings]
    let sshConfigId: string | undefined
    if (source.sshConfigId) {
      const ssh = project.sshConfigs.get(source.sshConfigId)
      if (ssh) {
        sshConfigId = ssh.id
        config.sshEnabled = true
      } else {
        warnings.push('Its SSH tunnel config was not found in the DataGrip settings; tunnel left off')
      }
    } else if (isLocalHost(endpoint.host) && !endpoint.filePath && ['Production', 'Staging'].includes(envName)) {
      warnings.push('Points at localhost without an SSH tunnel')
    }

    const stored = existingConnections(planned, env).find((c) => sameDatabase(c, config))
    const alreadyPlanned = env.items.find((i) => i.status === 'new' && sameDatabase(i.config, config))
    const dupName = stored?.name ?? alreadyPlanned?.config.name
    const item: PlannedItem = {
      sourceId: source.uuid,
      config,
      sshConfigId,
      status: dupName ? 'duplicate' : 'new',
      duplicateOf: dupName ? `${planned.name} / ${env.name} / ${dupName}` : undefined,
      warnings
    }
    env.items.push(item)
    if (item.status === 'new' && sshConfigId) {
      referencedSsh.set(sshConfigId, project.sshConfigs.get(sshConfigId)!)
    }
  }

  for (const config of referencedSsh.values()) {
    plan.sshConfigs.push({ config, existing: findSshProfile(config, profiles) })
  }

  const sort = (a: { name: string }, b: { name: string }): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  plan.projects.sort(sort)
  for (const p of plan.projects) p.environments.sort(sort)

  plan.notes.push(
    'Passwords live in the DataGrip keychain and cannot be read. DataDock asks for them the first time you connect.'
  )
  if (!project.hasLocalFile) {
    plan.notes.push('dataSources.local.xml is missing, so user names and SSH tunnels could not be read.')
  }
  if (project.sources.some((s) => s.sshConfigId) && !project.hasSshFile) {
    plan.notes.push('No DataGrip sshConfigs.xml was found on this machine; tunnels could not be mapped.')
  }
  return plan
}

function sshLabel(plan: Plan, item: PlannedItem): string | undefined {
  if (!item.sshConfigId) return undefined
  const entry = plan.sshConfigs.find((s) => s.config.id === item.sshConfigId)
  return entry?.existing?.name ?? entry?.config.label ?? plan.project.sshConfigs.get(item.sshConfigId)?.label
}

// ---- public API -------------------------------------------------------------

export async function pickFolder(): Promise<{ canceled: boolean; folder?: string }> {
  const suggested = join(homedir(), 'DataGripProjects')
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose a DataGrip project folder',
    defaultPath: existsSync(suggested) ? suggested : homedir(),
    properties: ['openDirectory']
  })
  if (canceled || !filePaths[0]) return { canceled: true }
  return { canceled: false, folder: filePaths[0] }
}

function resolveWorkspaceId(workspaceId?: string): string {
  const catalog = store.catalogForRenderer()
  if (workspaceId && catalog.workspaces.some((w) => w.id === workspaceId)) return workspaceId
  return catalog.activeWorkspaceId ?? catalog.workspaces[0]?.id ?? ''
}

export function preview(folder: string, workspaceId?: string): DataGripPreview {
  const plan = buildPlan(folder, resolveWorkspaceId(workspaceId))
  let newCount = 0
  let duplicates = 0
  const projects: DataGripPlannedProject[] = plan.projects.map((p) => ({
    name: p.name,
    exists: p.exists,
    environments: p.environments.map((e) => ({
      name: e.name,
      exists: e.exists,
      connections: e.items.map((item): DataGripPlannedConnection => {
        if (item.status === 'new') newCount++
        else duplicates++
        const c = item.config
        return {
          sourceId: item.sourceId,
          name: c.name,
          driver: c.driver,
          host: c.host,
          port: c.port,
          database: c.database,
          user: c.user,
          filePath: c.filePath,
          production: c.production,
          sshProfile: sshLabel(plan, item),
          status: item.status,
          duplicateOf: item.duplicateOf,
          warnings: item.warnings
        }
      })
    }))
  }))
  const sshProfiles: DataGripSshProfilePlan[] = plan.sshConfigs.map((s) => ({
    name: s.existing?.name ?? s.config.label,
    host: s.config.host,
    user: s.config.user,
    exists: !!s.existing
  }))
  return {
    folder,
    projectName: basename(plan.project.projectDir),
    workspaceId: plan.workspaceId,
    projects,
    skipped: plan.skipped,
    sshProfiles,
    notes: plan.notes,
    counts: { sources: plan.project.sources.length, new: newCount, duplicates, skipped: plan.skipped.length }
  }
}

/** Write the chosen data sources into the workspace. Re-plans from the files so
 * the result reflects the catalog as it is now, not as it was previewed. */
export function apply(folder: string, workspaceId: string | undefined, sourceIds: string[]): DataGripImportResult {
  let targetId = resolveWorkspaceId(workspaceId)
  if (!targetId) {
    const catalog = store.addWorkspace(basename(readProject(folder).projectDir))
    targetId = catalog.activeWorkspaceId ?? catalog.workspaces[0].id
  }
  const plan = buildPlan(folder, targetId)
  const wanted = new Set(sourceIds)
  const selected = plan.projects
    .flatMap((p) => p.environments)
    .flatMap((e) => e.items)
    .filter((item) => item.status === 'new' && wanted.has(item.sourceId))
  const neededSsh = new Set(selected.map((item) => item.sshConfigId).filter(Boolean))

  const profileIdFor = new Map<string, string>()
  let sshProfilesCreated = 0
  for (const { config, existing } of plan.sshConfigs) {
    if (!neededSsh.has(config.id)) continue
    if (existing) {
      profileIdFor.set(config.id, existing.id)
      continue
    }
    const method = sshAuthMethod(config)
    const saved = settings.saveSshProfile({
      name: config.label,
      host: config.host,
      port: config.port,
      user: config.user,
      authMethod: method,
      keyPath: method === 'key' ? config.keyPath || join(homedir(), '.ssh', 'id_rsa') : undefined
    })
    const created = findSshProfile(config, saved.sshProfiles)
    if (created) {
      profileIdFor.set(config.id, created.id)
      sshProfilesCreated++
    }
  }

  let imported = 0
  const merge: store.MergeProject[] = []
  for (const p of plan.projects) {
    const environments: store.MergeProject['environments'] = []
    for (const e of p.environments) {
      const connections: ConnectionConfig[] = []
      for (const item of e.items) {
        if (item.status !== 'new' || !wanted.has(item.sourceId)) continue
        const config = { ...item.config }
        if (item.sshConfigId) {
          const profileId = profileIdFor.get(item.sshConfigId)
          if (profileId) config.sshProfileId = profileId
          else delete config.sshEnabled
        }
        connections.push(config)
      }
      if (connections.length) environments.push({ name: e.name, connections })
    }
    if (environments.length) {
      merge.push({ name: p.name, environments })
      imported += environments.reduce((n, e) => n + e.connections.length, 0)
    }
  }

  const catalog = merge.length ? store.mergeIntoWorkspace(targetId, merge) : store.catalogForRenderer()
  return { catalog, imported, sshProfilesCreated }
}
