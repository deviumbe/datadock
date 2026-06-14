import { defineStore } from 'pinia'
import { reactive, ref, computed } from 'vue'
import type {
  ConnectionConfig,
  ConnectionState,
  Project,
  TableInfo,
  Workspace
} from '@shared/types'

export const useWorkspace = defineStore('workspace', () => {
  const projects = ref<Project[]>([])
  const expandedProjects = reactive<Set<string>>(new Set())
  const expandedEnvs = reactive<Set<string>>(new Set())
  const connStates = reactive<Record<string, ConnectionState>>({})
  const txn = reactive<Record<string, boolean>>({}) // active transaction per connection

  const activeConnectionId = ref<string | null>(null)
  const error = ref<string | null>(null)

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

  function applyWorkspace(ws: Workspace): void {
    projects.value = ws.projects
    // Expand everything the first time so the tree is visible.
    if (expandedProjects.size === 0 && expandedEnvs.size === 0) {
      for (const p of ws.projects) {
        expandedProjects.add(p.id)
        for (const e of p.environments) expandedEnvs.add(e.id)
      }
    }
  }

  async function load(): Promise<void> {
    applyWorkspace(await window.api.workspace.get())
  }

  function toggleProject(id: string): void {
    expandedProjects.has(id) ? expandedProjects.delete(id) : expandedProjects.add(id)
  }
  function toggleEnv(id: string): void {
    expandedEnvs.has(id) ? expandedEnvs.delete(id) : expandedEnvs.add(id)
  }

  function findConnection(id: string): ConnectionConfig | undefined {
    for (const p of projects.value) {
      for (const e of p.environments) {
        const c = e.connections.find((x) => x.id === id)
        if (c) return c
      }
    }
    return undefined
  }

  // ---- tree mutations -------------------------------------------------------
  const addProject = async (name: string) => applyWorkspace(await window.api.workspace.addProject(name))
  const renameProject = async (id: string, name: string) =>
    applyWorkspace(await window.api.workspace.renameProject(id, name))
  const deleteProject = async (id: string) =>
    applyWorkspace(await window.api.workspace.deleteProject(id))
  const addEnvironment = async (projectId: string, name: string) => {
    applyWorkspace(await window.api.workspace.addEnvironment(projectId, name))
  }
  const renameEnvironment = async (id: string, name: string) =>
    applyWorkspace(await window.api.workspace.renameEnvironment(id, name))
  const deleteEnvironment = async (id: string) =>
    applyWorkspace(await window.api.workspace.deleteEnvironment(id))
  const saveConnection = async (environmentId: string, config: ConnectionConfig) =>
    applyWorkspace(await window.api.workspace.saveConnection(environmentId, config))
  const deleteConnection = async (id: string) => {
    if (connStates[id] === 'connected') await disconnect(id)
    if (activeConnectionId.value === id) activeConnectionId.value = null
    delete tablesPerConn[id]
    applyWorkspace(await window.api.workspace.deleteConnection(id))
  }
  const duplicateConnection = async (id: string) =>
    applyWorkspace(await window.api.workspace.duplicateConnection(id))

  // ---- connecting -----------------------------------------------------------
  async function connectAndOpen(id: string): Promise<void> {
    error.value = null
    activeConnectionId.value = id
    if (connStates[id] === 'connected') {
      await refreshTables(id)
      return
    }
    connStates[id] = 'connecting'
    try {
      await window.api.db.connect(id)
      connStates[id] = 'connected'
      await refreshTables(id)
    } catch (e) {
      connStates[id] = 'error'
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function disconnect(id: string): Promise<void> {
    await window.api.db.disconnect(id)
    connStates[id] = 'disconnected'
    txn[id] = false
    // Clear the cached table list for this connection.
    delete tablesPerConn[id]
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
  }

  async function exportConnections(): Promise<void> {
    await window.api.io.exportConnections()
  }
  async function importConnections(): Promise<void> {
    const res = await window.api.io.importConnections()
    if (res && !res.canceled && res.workspace) {
      applyWorkspace(res.workspace)
      for (const p of res.workspace.projects) {
        expandedProjects.add(p.id)
        for (const e of p.environments) expandedEnvs.add(e.id)
      }
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

  return {
    projects,
    expandedProjects,
    expandedEnvs,
    connStates,
    txn,
    beginTxn,
    commitTxn,
    rollbackTxn,
    activeConnectionId,
    tables,
    error,
    schemas,
    load,
    toggleProject,
    toggleEnv,
    findConnection,
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
    disconnect,
    refreshTables,
    exportConnections,
    importConnections
  }
})
