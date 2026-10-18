<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, computed, watch } from 'vue'
import { useWorkspace } from './stores/workspace'
import { useTabs } from './stores/tabs'
import { useUi } from './stores/ui'
import { useSettings } from './stores/settings'
import Sidebar from './components/Sidebar.vue'
import MainPanel from './components/MainPanel.vue'
import ConnectionModal from './components/ConnectionModal.vue'
import TopologyPanel from './components/TopologyPanel.vue'
import TopologyEditorModal from './components/TopologyEditorModal.vue'
import NamePrompt from './components/NamePrompt.vue'
import NewProjectModal from './components/NewProjectModal.vue'
import CommandPalette from './components/CommandPalette.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import SettingsModal from './components/SettingsModal.vue'
import UpdateNotice from './components/UpdateNotice.vue'
import TaskTray from './components/TaskTray.vue'
import LockScreen from './components/LockScreen.vue'
import { useUpdates } from './stores/updates'
import { useVault } from './stores/vault'
import type { Workspace, ConnectionConfig, Environment, Project, Topology } from '@shared/types'

const ws = useWorkspace()
const tabs = useTabs()
const ui = useUi()
const settings = useSettings()
const updates = useUpdates()
const vault = useVault()

const sidebarWidth = computed(() => (ui.sidebarCollapsed ? '0px' : '264px'))

onMounted(async () => {
  // Appearance is local, so the lock screen is themed; the catalog waits for unlock.
  await vault.refresh()
  void settings.load()
  if (!vault.locked) void ws.load()
  updates.init()
})

// ---- vault lock / unlock ----------------------------------------------------
const vaultNotice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | undefined
function showVaultNotice(text: string): void {
  vaultNotice.value = text
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (vaultNotice.value = ''), 4000)
}

async function reloadFromVault(): Promise<void> {
  await Promise.all([ws.load(), settings.load(), settings.loadMcp()])
}

let unlistenVault: (() => void) | undefined
onMounted(() => {
  unlistenVault = vault.listen(() => {
    void reloadFromVault()
    showVaultNotice('Vault reloaded: it was changed on another device.')
  })
})
onBeforeUnmount(() => unlistenVault?.())

watch(
  () => vault.locked,
  (locked, wasLocked) => {
    if (locked) {
      for (const p of ws.allProjects)
        for (const e of p.environments) for (const c of e.connections) tabs.closeForConnection(c.id)
      ws.activeConnectionId = null
      ui.settingsOpen = false
      ui.closePalette()
      ui.closeTopology()
      void ws.load()
    } else if (wasLocked) {
      void reloadFromVault()
    }
  }
)

// ---- native menu actions ----------------------------------------------------
function handleMenu(action: string): void {
  if (action === 'toggleSidebar') {
    ui.toggleSidebar()
    return
  }
  if (action === 'lockVault') {
    void vault.lock()
    return
  }
  if (action === 'toggleTheme') {
    ui.toggleTheme()
    return
  }
  if (action === 'exportConnections') {
    void ws.exportConnections()
    return
  }
  if (action === 'importConnections') {
    void ws.importConnections()
    return
  }
  if (action === 'openSettings') {
    ui.settingsOpen = true
    return
  }
  if (action === 'checkForUpdates') {
    updates.checkManually()
    return
  }
  const id = ws.activeConnectionId
  if (!id) return
  const tab = tabs.activeTab(id)
  switch (action) {
    case 'newQuery':
      tabs.openQuery(id)
      break
    case 'closeTab':
      if (tab) tabs.closeTab(tab.id)
      break
    case 'save':
      if (tab?.kind === 'table' && tabs.dirtyCount(tab) > 0) void tabs.commit(tab)
      break
    case 'undo':
      if (tab?.kind === 'table') tabs.undo(tab)
      break
    case 'redo':
      if (tab?.kind === 'table') tabs.redo(tab)
      break
    case 'refresh':
      if (tab) void refreshTab(tab)
      break
    case 'refreshTables':
      ws.refreshTables(id)
      break
    case 'databases':
      tabs.openServer(id, 'databases')
      break
    case 'users':
      tabs.openServer(id, 'users')
      break
    case 'processes':
      tabs.openServer(id, 'processes')
      break
    case 'tableSizes':
      ui.tableSizesOpen = true
      break
    case 'snapshots':
      ui.snapshotsOpen = true
      break
    case 'recoverDeleted':
      ui.recoverOpen = true
      break
    case 'columnSearch':
      ui.columnSearchOpen = true
      break
    case 'performance':
      tabs.openPerformance(id)
      break
    case 'docs':
      tabs.openDocs(id)
      break
    case 'search':
      tabs.openSearch(id)
      break
    case 'analytics':
      tabs.openAnalytics(id)
      break
    case 'history':
      tabs.openHistory(id)
      break
    case 'snippets':
      tabs.openSnippets(id)
      break
    case 'diagram':
      tabs.openDiagram(id)
      break
    case 'visualQuery':
      tabs.openVisualQuery(id)
      break
    case 'chat':
      tabs.openChat(id)
      break
    case 'envDiff':
      tabs.openEnvDiff(id)
      break
    case 'redisQueues':
      tabs.openRedisQueues(id)
      break
    case 'schemaDiff':
      tabs.openSchemaDiff(id)
      break
    case 'dataDiff':
      tabs.openDataDiff(id)
      break
    case 'import':
      if (ws.isReadOnly(id)) {
        ws.error = 'Read-only connection: import is disabled.'
      } else {
        ui.importOpen = true
      }
      break
    case 'exportDb':
      ui.exportDbOpen = true
      break
    case 'cloneSqlite':
      ui.cloneSqliteOpen = true
      break
    case 'disconnect':
      void ws.disconnect(id)
      break
  }
}

/** ⌘R: re-query the active table tab (data or structure view). */
async function refreshTab(tab: NonNullable<ReturnType<typeof tabs.activeTab>>): Promise<void> {
  if (tab.kind !== 'table') return
  if (tab.viewMode === 'structure') {
    void tabs.loadStructure(tab)
    return
  }
  const dirty = tabs.dirtyCount(tab)
  if (dirty > 0) {
    const ok = await ui.confirmDialog({
      title: 'Discard unsaved changes?',
      message: `Refreshing reloads the table and discards ${dirty} pending change${dirty === 1 ? '' : 's'}.`,
      confirmLabel: 'Discard & refresh',
      danger: true
    })
    if (!ok) return
  }
  void tabs.reloadTable(tab)
}

let unsubscribe: (() => void) | undefined
onMounted(() => {
  unsubscribe = window.api.onMenuAction(handleMenu)
})
onBeforeUnmount(() => unsubscribe?.())

// Collapse the project sidebar the first time a connection successfully opens.
watch(
  () => (ws.activeConnectionId ? ws.connStates[ws.activeConnectionId] : null),
  (state) => {
    if (state === 'connected') ui.autoCollapseOnConnect()
  }
)

// ---- connection modal -------------------------------------------------------
const connModal = ref(false)
const connEnvId = ref('')
const connConfig = shallowRef<ConnectionConfig | undefined>(undefined)

function openNewConnection(environmentId: string): void {
  connEnvId.value = environmentId
  connConfig.value = undefined
  connModal.value = true
}
function openEditConnection(conn: ConnectionConfig, environmentId: string): void {
  connEnvId.value = environmentId
  connConfig.value = conn
  connModal.value = true
}
async function saveConnection(environmentId: string, config: ConnectionConfig): Promise<void> {
  await ws.saveConnection(environmentId, config)
  connModal.value = false
}

// ---- replication topologies -------------------------------------------------
const topoModal = ref(false)
const topoEditing = ref<Topology | undefined>(undefined)
function openNewTopology(): void {
  topoEditing.value = undefined
  topoModal.value = true
}
function openEditTopology(t: Topology): void {
  topoEditing.value = t
  topoModal.value = true
}
async function saveTopology(t: Topology): Promise<void> {
  await ws.saveTopology(t)
  topoModal.value = false
}
async function deleteTopology(t: Topology): Promise<void> {
  const ok = await ui.confirmDialog({
    title: 'Delete topology',
    message: `Delete "${t.name}"? Connections themselves are not affected.`,
    confirmLabel: 'Delete',
    danger: true
  })
  if (!ok) return
  if (ui.topologyId === t.id) ui.closeTopology()
  await ws.deleteTopology(t.id)
}

// ---- name prompt ------------------------------------------------------------
const prompt = ref(false)
const promptTitle = ref('')
const promptInitial = ref('')
let promptHandler: (name: string) => void = () => {}

function askName(title: string, initial: string, handler: (name: string) => void): void {
  promptTitle.value = title
  promptInitial.value = initial
  promptHandler = handler
  prompt.value = true
}
function submitPrompt(name: string): void {
  promptHandler(name)
  prompt.value = false
}

// ---- command palette --------------------------------------------------------
function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    ui.togglePalette()
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault()
    ui.settingsOpen = true
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))

// ---- sidebar event handlers -------------------------------------------------
const newProject = ref(false)
const onNewProject = () => (newProject.value = true)
function submitNewProject(name: string, environments: string[]): void {
  void ws.addProject({ name, environments })
  newProject.value = false
}

const onNewWorkspace = () => askName('New Workspace', '', (n) => ws.addWorkspace(n))
const onEditWorkspace = (c: Workspace) => askName('Rename Workspace', c.name, (n) => ws.renameWorkspace(c.id, n))
async function onDeleteWorkspace(c: Workspace): Promise<void> {
  const count = ws.allProjects.filter((p) => p.workspaceId === c.id).length
  const ok = await ui.confirmDialog({
    title: 'Delete workspace',
    message: `Delete "${c.name}" and its ${count} project${count === 1 ? '' : 's'}, including all environments and connections?`,
    confirmLabel: 'Delete',
    danger: true
  })
  if (!ok) return
  for (const p of ws.allProjects.filter((x) => x.workspaceId === c.id))
    for (const e of p.environments) for (const conn of e.connections) tabs.closeForConnection(conn.id)
  await ws.deleteWorkspace(c.id)
}
const onMoveProject = (p: Project, workspaceId: string) => void ws.moveProject(p.id, workspaceId)
const onMoveProjectToNewWorkspace = (p: Project) =>
  askName(`Move "${p.name}" to a new workspace`, '', async (n) => {
    await ws.addWorkspace(n)
    if (ws.activeWorkspaceId) await ws.moveProject(p.id, ws.activeWorkspaceId)
  })
const onEditProject = (p: Project) => askName('Rename Project', p.name, (n) => ws.renameProject(p.id, n))
const onNewEnvironment = (projectId: string) =>
  askName('New Environment', '', (n) => ws.addEnvironment(projectId, n))
const onEditEnvironment = (e: Environment) =>
  askName('Rename Environment', e.name, (n) => ws.renameEnvironment(e.id, n))

function onDeleteProject(p: Project): void {
  if (confirm(`Delete project "${p.name}" and all its environments and connections?`)) {
    ws.deleteProject(p.id)
  }
}
function onDeleteEnvironment(e: Environment): void {
  if (confirm(`Delete environment "${e.name}" and its connections?`)) ws.deleteEnvironment(e.id)
}
function onDeleteConnection(c: ConnectionConfig): void {
  if (confirm(`Delete connection "${c.name}"?`)) {
    tabs.closeForConnection(c.id)
    ws.deleteConnection(c.id)
  }
}
function onDuplicateConnection(c: ConnectionConfig): void {
  void ws.duplicateConnection(c.id)
}
</script>

<template>
  <div class="layout" :class="{ mac: ui.isMac, collapsed: ui.sidebarCollapsed }">
    <Sidebar
      class="sidebar-slot"
      @new-project="onNewProject"
      @edit-project="onEditProject"
      @delete-project="onDeleteProject"
      @move-project="onMoveProject"
      @move-project-to-new-workspace="onMoveProjectToNewWorkspace"
      @new-workspace="onNewWorkspace"
      @edit-workspace="onEditWorkspace"
      @delete-workspace="onDeleteWorkspace"
      @new-environment="onNewEnvironment"
      @edit-environment="onEditEnvironment"
      @delete-environment="onDeleteEnvironment"
      @new-connection="openNewConnection"
      @edit-connection="openEditConnection"
      @delete-connection="onDeleteConnection"
      @duplicate-connection="onDuplicateConnection"
      @new-topology="openNewTopology"
      @edit-topology="openEditTopology"
      @delete-topology="deleteTopology"
    />
    <MainPanel />

    <TopologyPanel
      v-if="ui.topologyId"
      :topology-id="ui.topologyId"
      @edit="openEditTopology"
    />
    <TopologyEditorModal
      v-if="topoModal"
      :topology="topoEditing"
      @save="saveTopology"
      @close="topoModal = false"
    />

    <ConnectionModal
      v-if="connModal"
      :environment-id="connEnvId"
      :config="connConfig"
      @save="saveConnection"
      @close="connModal = false"
    />
    <NamePrompt
      v-if="prompt"
      :title="promptTitle"
      :initial="promptInitial"
      @submit="submitPrompt"
      @close="prompt = false"
    />
    <CommandPalette v-if="ui.paletteOpen" @close="ui.closePalette()" />
    <SettingsModal v-if="ui.settingsOpen" @close="ui.settingsOpen = false" />
    <NewProjectModal
      v-if="newProject"
      :workspace-name="ws.workspaces.length > 1 ? ws.activeWorkspace?.name : undefined"
      @submit="submitNewProject"
      @close="newProject = false"
    />
    <ConfirmModal />
    <UpdateNotice />
    <TaskTray />
    <Transition name="notice">
      <div v-if="vaultNotice" class="vault-notice">{{ vaultNotice }}</div>
    </Transition>
    <LockScreen v-if="vault.locked" />
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: v-bind(sidebarWidth) 1fr;
  height: 100%;
  width: 100%;
  position: relative;
  transition: grid-template-columns 0.18s ease;
}
.sidebar-slot {
  overflow: hidden;
}
.vault-notice {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 250;
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  color: var(--text);
  font-size: 12.5px;
  box-shadow: var(--shadow-pop);
}
.notice-enter-active,
.notice-leave-active {
  transition: opacity var(--dur-2), transform var(--dur-2);
}
.notice-enter-from,
.notice-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
