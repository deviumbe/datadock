<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, computed, watch } from 'vue'
import { useWorkspace } from './stores/workspace'
import { useTabs } from './stores/tabs'
import { useUi } from './stores/ui'
import Sidebar from './components/Sidebar.vue'
import MainPanel from './components/MainPanel.vue'
import ConnectionModal from './components/ConnectionModal.vue'
import NamePrompt from './components/NamePrompt.vue'
import CommandPalette from './components/CommandPalette.vue'
import type { ConnectionConfig, Environment, Project } from '@shared/types'

const ws = useWorkspace()
const tabs = useTabs()
const ui = useUi()

const sidebarWidth = computed(() => (ui.sidebarCollapsed ? '0px' : '264px'))

onMounted(() => ws.load())

// ---- native menu actions ----------------------------------------------------
function handleMenu(action: string): void {
  if (action === 'toggleSidebar') {
    ui.toggleSidebar()
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
    case 'history':
      tabs.openHistory(id)
      break
    case 'snippets':
      tabs.openSnippets(id)
      break
    case 'diagram':
      tabs.openDiagram(id)
      break
    case 'import':
      if (ws.findConnection(id)?.readOnly) {
        ws.error = 'Read-only connection: import is disabled.'
      } else {
        ui.importOpen = true
      }
      break
    case 'exportDb':
      ui.exportDbOpen = true
      break
    case 'disconnect':
      void ws.disconnect(id)
      break
  }
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
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))

// ---- sidebar event handlers -------------------------------------------------
const onNewProject = () => askName('New Project', '', (n) => ws.addProject(n))
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
      @new-environment="onNewEnvironment"
      @edit-environment="onEditEnvironment"
      @delete-environment="onDeleteEnvironment"
      @new-connection="openNewConnection"
      @edit-connection="openEditConnection"
      @delete-connection="onDeleteConnection"
      @duplicate-connection="onDuplicateConnection"
    />
    <MainPanel />

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
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: v-bind(sidebarWidth) 1fr;
  height: 100%;
  width: 100%;
  transition: grid-template-columns 0.18s ease;
}
.sidebar-slot {
  overflow: hidden;
}
</style>
