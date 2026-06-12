import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
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

  const activeConnectionId = ref<string | null>(null)
  const tables = ref<TableInfo[]>([])
  const error = ref<string | null>(null)
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
    applyWorkspace(await window.api.workspace.deleteConnection(id))
  }

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
    if (activeConnectionId.value === id) tables.value = []
  }

  async function refreshTables(id: string): Promise<void> {
    try {
      tables.value = await window.api.db.listTables(id)
    } catch (e) {
      tables.value = []
      error.value = e instanceof Error ? e.message : String(e)
    }
    void loadSchema(id)
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
    connectAndOpen,
    disconnect,
    refreshTables
  }
})
