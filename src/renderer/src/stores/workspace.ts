import { defineStore } from 'pinia'
import { reactive, ref, computed } from 'vue'
import type {
  Workspace,
  ConnectionConfig,
  ConnectionState,
  ConnStatePayload,
  ErModel,
  NewProjectInput,
  Project,
  TableInfo,
  Topology,
  Catalog
} from '@shared/types'
import { useTabs } from './tabs'

export const useWorkspace = defineStore('workspace', () => {
  const workspaces = ref<Workspace[]>([])
  const activeWorkspaceId = ref<string | null>(null)
  const allProjects = ref<Project[]>([])
  // Everything that walks the tree (sidebar, palette, pickers) sees only the
  // active workspace's projects, so two workspaces' lists never mix.
  const projects = computed<Project[]>(() =>
    allProjects.value.filter((p) => p.workspaceId === activeWorkspaceId.value)
  )
  const activeWorkspace = computed<Workspace | undefined>(() =>
    workspaces.value.find((c) => c.id === activeWorkspaceId.value)
  )
  const expandedProjects = reactive<Set<string>>(new Set())
  const expandedEnvs = reactive<Set<string>>(new Set())
  // Connection state is owned by the main process and pushed here — this map is
  // a pure mirror, never set optimistically.
  const connStates = reactive<Record<string, ConnectionState>>({})
  const connErrors = reactive<Record<string, string | undefined>>({})
  const connVerifiedAt = reactive<Record<string, number | undefined>>({})
  const txn = reactive<Record<string, boolean>>({}) // active transaction per connection

  function applyConnState(p: ConnStatePayload): void {
    const prev = connStates[p.id]
    connStates[p.id] = p.state
    connErrors[p.id] = p.error
    if (p.verifiedAt) connVerifiedAt[p.id] = p.verifiedAt
    // When a connection recovers (heal or manual reconnect) and it's the one in
    // view, pull a fresh table list — the cached one may be stale or empty.
    if (p.state === 'connected' && prev && prev !== 'connected') {
      if (activeConnectionId.value === p.id) void refreshTables(p.id)
    }
    if (p.state === 'disconnected') delete tablesPerConn[p.id]
  }

  /** Subscribe to pushed state + pull the current snapshot once. */
  function watchConnStates(): void {
    window.api.db.onConnState?.(applyConnState)
    void window.api.db.connStates?.().then((states) => {
      for (const s of states) applyConnState(s)
    })
  }

  const activeConnectionId = ref<string | null>(null)
  const error = ref<string | null>(null)
  const topologies = ref<Topology[]>([])

  async function beginTxn(id: string): Promise<void> {
    try {
      await window.api.db.txnBegin(id)
      txn[id] = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }
  async function commitTxn(id: string): Promise<void> {
    try {
      await window.api.db.txnCommit(id)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
    txn[id] = false
  }
  async function rollbackTxn(id: string): Promise<void> {
    try {
      await window.api.db.txnRollback(id)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
    txn[id] = false
  }

  // Per-connection table cache: switching connections is instant (cache hit)
  // and stale async responses never corrupt another connection's list.
  const tablesPerConn = reactive<Record<string, TableInfo[]>>({})
  const tables = computed<TableInfo[]>(() =>
    activeConnectionId.value ? (tablesPerConn[activeConnectionId.value] ?? []) : []
  )

  // table -> columns, per connection, for SQL editor autocomplete
  const schemas = reactive<Record<string, Record<string, string[]>>>({})

  // table -> note text, per connection (local-only documentation)
  const tableNotes = reactive<Record<string, Record<string, string>>>({})
  function tableNote(connId: string, table: string): string {
    return tableNotes[connId]?.[table] ?? ''
  }
  async function loadNotes(id: string): Promise<void> {
    try {
      tableNotes[id] = await window.api.notes.list(id)
    } catch {
      tableNotes[id] = {}
    }
  }
  async function setTableNote(connId: string, table: string, text: string): Promise<void> {
    tableNotes[connId] = await window.api.notes.set(connId, table, text)
  }

  // Temporary write-unlock for read-only connections: connId -> expiry epoch ms.
  // A ticking `now` ref drives countdowns and auto-relock reactively.
  const writeUnlocks = reactive<Record<string, number>>({})
  const now = ref(Date.now())
  let unlockTimer: ReturnType<typeof setInterval> | undefined
  function ensureUnlockTimer(): void {
    if (unlockTimer) return
    unlockTimer = setInterval(() => {
      now.value = Date.now()
      let any = false
      for (const [id, exp] of Object.entries(writeUnlocks)) {
        if (exp <= now.value) delete writeUnlocks[id]
        else any = true
      }
      if (!any && unlockTimer) {
        clearInterval(unlockTimer)
        unlockTimer = undefined
      }
    }, 1000)
  }
  function unlockWrites(connId: string, minutes = 15): void {
    writeUnlocks[connId] = Date.now() + minutes * 60_000
    now.value = Date.now()
    ensureUnlockTimer()
  }
  function relockWrites(connId: string): void {
    delete writeUnlocks[connId]
  }
  function isWriteUnlocked(connId: string): boolean {
    const exp = writeUnlocks[connId]
    return !!exp && exp > now.value
  }
  function unlockSecondsLeft(connId: string): number {
    const exp = writeUnlocks[connId]
    return exp ? Math.max(0, Math.round((exp - now.value) / 1000)) : 0
  }
  /** Effective read-only state: the connection flag, unless temporarily unlocked. */
  function isReadOnly(connId: string): boolean {
    return !!findConnection(connId)?.readOnly && !isWriteUnlocked(connId)
  }

  // Entity-relationship model (PK/FK graph) per connection — cached for the
  // record explorer and the grid's inline FK-navigation arrows. Stored in a ref
  // and replaced immutably so dependent computeds always re-run when it lands.
  const erModels = ref<Record<string, ErModel>>({})
  async function loadErModel(id: string): Promise<ErModel | undefined> {
    if (!erModels.value[id]) {
      const model = await window.api.db.erModel(id)
      erModels.value = { ...erModels.value, [id]: model }
    }
    return erModels.value[id]
  }

  function applyCatalog(ws: Catalog): void {
    workspaces.value = ws.workspaces ?? []
    activeWorkspaceId.value = ws.activeWorkspaceId ?? workspaces.value[0]?.id ?? null
    allProjects.value = ws.projects
    topologies.value = ws.topologies ?? []
    // Expand everything the first time so the tree is visible.
    if (expandedProjects.size === 0 && expandedEnvs.size === 0) {
      for (const p of ws.projects) {
        expandedProjects.add(p.id)
        for (const e of p.environments) expandedEnvs.add(e.id)
      }
    }
  }

  async function load(): Promise<void> {
    applyCatalog(await window.api.catalog.get())
  }

  const saveTopology = async (t: Topology): Promise<void> =>
    applyCatalog(await window.api.catalog.saveTopology(t))
  const deleteTopology = async (id: string): Promise<void> =>
    applyCatalog(await window.api.catalog.deleteTopology(id))

  function toggleProject(id: string): void {
    expandedProjects.has(id) ? expandedProjects.delete(id) : expandedProjects.add(id)
  }
  function toggleEnv(id: string): void {
    expandedEnvs.has(id) ? expandedEnvs.delete(id) : expandedEnvs.add(id)
  }

  function findConnection(id: string): ConnectionConfig | undefined {
    for (const p of allProjects.value) {
      for (const e of p.environments) {
        const c = e.connections.find((x) => x.id === id)
        if (c) return c
      }
    }
    return undefined
  }

  // ---- workspaces ------------------------------------------------------------
  const addWorkspace = async (name: string) => applyCatalog(await window.api.catalog.addWorkspace(name))
  const renameWorkspace = async (id: string, name: string) =>
    applyCatalog(await window.api.catalog.renameWorkspace(id, name))
  const deleteWorkspace = async (id: string) => {
    for (const p of allProjects.value.filter((x) => x.workspaceId === id))
      for (const e of p.environments) for (const c of e.connections) await forgetConnection(c.id)
    applyCatalog(await window.api.catalog.deleteWorkspace(id))
  }
  const moveProject = async (projectId: string, workspaceId: string) =>
    applyCatalog(await window.api.catalog.moveProject(projectId, workspaceId))
  async function setActiveWorkspace(id: string): Promise<void> {
    if (id === activeWorkspaceId.value) return
    applyCatalog(await window.api.catalog.setActiveWorkspace(id))
    const active = activeConnectionId.value
    if (active && !projects.value.some((p) => p.environments.some((e) => e.connections.some((c) => c.id === active)))) {
      activeConnectionId.value = null
    }
  }

  // ---- tree mutations -------------------------------------------------------
  const addProject = async (input: Omit<NewProjectInput, 'workspaceId'> & { workspaceId?: string }) => {
    const before = new Set(allProjects.value.map((p) => p.id))
    applyCatalog(
      await window.api.catalog.addProject({ ...input, workspaceId: input.workspaceId ?? activeWorkspaceId.value ?? '' })
    )
    for (const p of allProjects.value) {
      if (before.has(p.id)) continue
      expandedProjects.add(p.id)
      for (const e of p.environments) expandedEnvs.add(e.id)
    }
  }
  const renameProject = async (id: string, name: string) =>
    applyCatalog(await window.api.catalog.renameProject(id, name))
  const deleteProject = async (id: string) =>
    applyCatalog(await window.api.catalog.deleteProject(id))
  const addEnvironment = async (projectId: string, name: string) => {
    applyCatalog(await window.api.catalog.addEnvironment(projectId, name))
  }
  const renameEnvironment = async (id: string, name: string) =>
    applyCatalog(await window.api.catalog.renameEnvironment(id, name))
  const deleteEnvironment = async (id: string) =>
    applyCatalog(await window.api.catalog.deleteEnvironment(id))
  const saveConnection = async (environmentId: string, config: ConnectionConfig) =>
    applyCatalog(await window.api.catalog.saveConnection(environmentId, config))
  async function forgetConnection(id: string): Promise<void> {
    if (connStates[id] === 'connected') await disconnect(id)
    if (activeConnectionId.value === id) activeConnectionId.value = null
    delete tablesPerConn[id]
  }
  const deleteConnection = async (id: string) => {
    await forgetConnection(id)
    applyCatalog(await window.api.catalog.deleteConnection(id))
  }
  const duplicateConnection = async (id: string) =>
    applyCatalog(await window.api.catalog.duplicateConnection(id))

  // ---- connecting -----------------------------------------------------------
  /** Connect a node for background monitoring — no tab/active-connection changes. */
  async function ensureConnected(id: string): Promise<void> {
    if (connStates[id] === 'connected') return
    connStates[id] = 'connecting'
    try {
      await window.api.db.connect(id)
      connStates[id] = 'connected'
    } catch (e) {
      connStates[id] = 'error'
      throw e
    }
  }

  async function connectAndOpen(id: string): Promise<void> {
    error.value = null
    activeConnectionId.value = id
    // Healthy and already open — just (re)load the table list.
    if (connStates[id] === 'connected') {
      await refreshTables(id)
      return
    }
    // A heal is already in flight — let the pushed state drive the UI.
    if (connStates[id] === 'connecting' || connStates[id] === 'reconnecting') return
    // Anything else (disconnected / unhealthy / error) means: (re)connect.
    // State transitions arrive via the pushed conn:state stream.
    try {
      await window.api.db.connect(id)
      // Re-open the tabs that were open for this connection last session. Done
      // synchronously here (before any await) so it runs ahead of the reactive
      // "open a default Query tab when a connection has none" fallback.
      useTabs().restoreForConnection(id)
      await refreshTables(id)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function disconnect(id: string): Promise<void> {
    await window.api.db.disconnect(id)
    // State ('disconnected') and the table-cache clear arrive via applyConnState.
    txn[id] = false
  }

  async function refreshTables(id: string): Promise<void> {
    try {
      const result = await window.api.db.listTables(id)
      // Guard: only store if this connection is still open/active.
      // Prevents a slow response from overwriting a different connection's list.
      if (connStates[id] === 'connected') {
        tablesPerConn[id] = result
      }
    } catch (e) {
      tablesPerConn[id] = []
      if (activeConnectionId.value === id) {
        error.value = e instanceof Error ? e.message : String(e)
      }
    }
    void loadSchema(id)
    void loadNotes(id)
    // Eagerly cache the FK graph so the grid's inline navigation arrows are
    // ready as soon as a table opens (best-effort; absent on non-SQL drivers).
    void loadErModel(id).catch(() => {})
  }

  async function exportConnections(): Promise<void> {
    await window.api.io.exportConnections()
  }
  async function importConnections(): Promise<void> {
    const res = await window.api.io.importConnections()
    if (res && !res.canceled && res.catalog) applyImportedCatalog(res.catalog)
  }
  /** Take over a catalog returned by an importer and expand the whole tree so
   * what just arrived is visible. */
  function applyImportedCatalog(catalog: Catalog): void {
    applyCatalog(catalog)
    for (const p of catalog.projects) {
      expandedProjects.add(p.id)
      for (const e of p.environments) expandedEnvs.add(e.id)
    }
  }

  /** Load the table/column map for autocomplete (best-effort, non-blocking). */
  async function loadSchema(id: string): Promise<void> {
    try {
      schemas[id] = await window.api.db.schema(id)
    } catch {
      schemas[id] = {}
    }
  }

  watchConnStates()

  return {
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    allProjects,
    projects,
    expandedProjects,
    expandedEnvs,
    connStates,
    connErrors,
    connVerifiedAt,
    txn,
    beginTxn,
    commitTxn,
    rollbackTxn,
    activeConnectionId,
    erModels,
    loadErModel,
    unlockWrites,
    relockWrites,
    isWriteUnlocked,
    unlockSecondsLeft,
    isReadOnly,
    tables,
    error,
    schemas,
    tableNotes,
    tableNote,
    setTableNote,
    load,
    toggleProject,
    toggleEnv,
    findConnection,
    addWorkspace,
    renameWorkspace,
    deleteWorkspace,
    moveProject,
    setActiveWorkspace,
    addProject,
    renameProject,
    deleteProject,
    addEnvironment,
    renameEnvironment,
    deleteEnvironment,
    saveConnection,
    deleteConnection,
    duplicateConnection,
    connectAndOpen,
    ensureConnected,
    disconnect,
    refreshTables,
    exportConnections,
    importConnections,
    applyImportedCatalog,
    topologies,
    saveTopology,
    deleteTopology
  }
})
