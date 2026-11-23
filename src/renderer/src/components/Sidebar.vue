<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useWorkspace } from '../stores/workspace'
import { useUi } from '../stores/ui'
import { useTheme } from '../stores/theme'
import { useTabs } from '../stores/tabs'
import type { Workspace, ConnectionConfig, Environment, Project, Topology } from '@shared/types'
import { isConnectionOpen, serverDatabaseId } from '@shared/types'
import logoUrl from '../assets/logo.png'
import Icon from './Icon.vue'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'
import ConnTaskIndicator from './ConnTaskIndicator.vue'

const ws = useWorkspace()
const ui = useUi()
const tabs = useTabs()
const theme = useTheme()
const explorer = computed(() => theme.settings.sidebarLayout === 'explorer')

const emit = defineEmits<{
  newProject: []
  editProject: [project: Project]
  deleteProject: [project: Project]
  moveProject: [project: Project, workspaceId: string]
  moveProjectToNewWorkspace: [project: Project]
  newWorkspace: []
  editWorkspace: [workspace: Workspace]
  deleteWorkspace: [workspace: Workspace]
  newEnvironment: [projectId: string]
  editEnvironment: [env: Environment]
  deleteEnvironment: [env: Environment]
  newConnection: [environmentId: string]
  editConnection: [conn: ConnectionConfig, environmentId: string]
  deleteConnection: [conn: ConnectionConfig]
  duplicateConnection: [conn: ConnectionConfig]
  newTopology: []
  editTopology: [topology: Topology]
  deleteTopology: [topology: Topology]
}>()

const empty = computed(() => ws.projects.length === 0)

// The workspace switcher only appears once there is something to switch between;
// with a single workspace the sidebar is the plain project tree.
const multiWorkspace = computed(() => ws.workspaces.length > 1)

const ctx = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

function openWorkspaceMenu(e: MouseEvent): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const active = ws.activeWorkspace
  const items: MenuItem[] = ws.workspaces.map((c) => ({
    label: `${c.id === active?.id ? '✓' : '\u2007'} ${c.name}`,
    action: () => void ws.setActiveWorkspace(c.id)
  }))
  if (items.length) items.push({ sep: true })
  items.push({ label: 'New workspace…', action: () => emit('newWorkspace') })
  if (active) {
    items.push(
      { label: `Rename “${active.name}”…`, action: () => emit('editWorkspace', active) },
      { label: `Delete “${active.name}”…`, danger: true, action: () => emit('deleteWorkspace', active) }
    )
  }
  ctx.value = { x: rect.left, y: rect.bottom + 4, items }
}

function openProjectMenu(e: MouseEvent, project: Project): void {
  const others = ws.workspaces.filter((c) => c.id !== project.workspaceId)
  const items: MenuItem[] = [
    { label: 'New environment', action: () => emit('newEnvironment', project.id) },
    { label: 'Rename', action: () => emit('editProject', project) }
  ]
  const targets: MenuItem[] = others.map((c) => ({
    label: c.name,
    action: () => emit('moveProject', project, c.id)
  }))
  if (targets.length) targets.push({ sep: true })
  targets.push({ label: 'New workspace…', action: () => emit('moveProjectToNewWorkspace', project) })
  items.push({ label: 'Move to workspace', children: targets })
  items.push({ sep: true }, { label: 'Delete', danger: true, action: () => emit('deleteProject', project) })
  ctx.value = { x: e.clientX, y: e.clientY, items }
}

function open(conn: ConnectionConfig): void {
  ws.connectAndOpen(conn.id)
}

/** A server row opens its Databases overview; only the caret collapses it. */
async function openServer(conn: ConnectionConfig): Promise<void> {
  await ws.connectAndOpen(conn.id)
  if (!ws.expandedServers.has(conn.id)) ws.toggleServer(conn.id)
  if (isConnectionOpen(ws.connStates[conn.id])) tabs.openServer(conn.id, 'databases')
}

const DB_FILTER_THRESHOLD = 8
const dbFilter = reactive<Record<string, string>>({})

function visibleDatabases(serverId: string): string[] {
  const all = ws.serverDatabases[serverId] ?? []
  const needle = dbFilter[serverId]?.trim().toLowerCase()
  return needle ? all.filter((d) => d.toLowerCase().includes(needle)) : all
}

// ---- workspace filter --------------------------------------------------------

const query = ref('')
const needle = computed(() => query.value.trim().toLowerCase())
const hits = (name: string): boolean => name.toLowerCase().includes(needle.value)

interface ConnNode {
  conn: ConnectionConfig
  databases: string[]
  open: boolean
}
interface EnvNode {
  env: Environment
  conns: ConnNode[]
  open: boolean
}
interface ProjectNode {
  project: Project
  envs: EnvNode[]
  open: boolean
}

/**
 * The visible tree. A match on a project or environment keeps everything below
 * it; otherwise only matching connections (or a server's matching databases)
 * survive. While filtering every surviving branch is shown expanded.
 */
const tree = computed<ProjectNode[]>(() => {
  const filtering = !!needle.value
  const out: ProjectNode[] = []
  for (const project of ws.projects) {
    const projectHit = !filtering || hits(project.name)
    const envs: EnvNode[] = []
    for (const env of project.environments) {
      const envHit = projectHit || hits(env.name)
      const conns: ConnNode[] = []
      for (const conn of env.connections) {
        const all = conn.serverMode ? visibleDatabases(conn.id) : []
        const connHit = envHit || hits(conn.name)
        const databases = connHit ? all : all.filter(hits)
        if (!connHit && !databases.length) continue
        conns.push({ conn, databases, open: ws.expandedServers.has(conn.id) || !connHit })
      }
      if (!envHit && !conns.length) continue
      envs.push({ env, conns, open: filtering || ws.expandedEnvs.has(env.id) })
    }
    if (!projectHit && !envs.length) continue
    out.push({ project, envs, open: filtering || ws.expandedProjects.has(project.id) })
  }
  return out
})

// Database names only exist once a server is listed, so filtering lists the
// servers that haven't been yet. Production servers are left alone: typing in
// a filter shouldn't open connections to them.
watch(needle, (n) => {
  if (!n) return
  for (const p of ws.projects)
    for (const e of p.environments)
      for (const c of e.connections) {
        if (!c.serverMode || c.production) continue
        if (ws.serverDatabases[c.id] || ws.serverLoading[c.id] || ws.serverErrors[c.id]) continue
        void ws.loadServerDatabases(c.id)
      }
})

const STATE_LABEL: Record<string, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  unhealthy: 'Connection lost',
  error: 'Connection failed',
  idle: 'Idle, closed to save resources; reconnects on use'
}

function stateTitle(id: string): string {
  const state = ws.connStates[id] || 'disconnected'
  let title = STATE_LABEL[state] ?? state
  const err = ws.connErrors[id]
  if ((state === 'unhealthy' || state === 'error') && err) title += ` — ${err}`
  const at = ws.connVerifiedAt[id]
  if (state === 'connected' && at) {
    const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
    title += secs < 5 ? ' · verified just now' : ` · verified ${secs}s ago`
  }
  if (state === 'unhealthy' || state === 'error') title += ' · click to reconnect'
  return title
}

const DRIVER_LABEL: Record<string, string> = {
  postgres: 'PG',
  mysql: 'SQL',
  sqlite: 'LITE',
  mssql: 'MS',
  oracle: 'ORA',
  mongodb: 'MDB',
  influxdb: 'IFX'
}
</script>

<template>
  <aside class="sidebar" :class="{ explorer }">
    <div class="side-head">
      <img class="logo" :src="logoUrl" alt="DataDock" />
      <span class="brand">DataDock</span>
      <button class="btn-ghost icon" title="Workspaces" @click="openWorkspaceMenu"><Icon name="building" :size="14" /></button>
      <button class="btn-ghost icon" title="New project" @click="emit('newProject')"><Icon name="plus" :size="14" /></button>
    </div>

    <button v-if="multiWorkspace" class="workspace-row" title="Switch workspace" @click="openWorkspaceMenu">
      <span class="workspace-icon"><Icon name="building" :size="13" /></span>
      <span class="workspace-name">{{ ws.activeWorkspace?.name ?? 'No workspace' }}</span>
      <span class="workspace-caret"><Icon name="chevronDown" :size="12" /></span>
    </button>

    <div v-if="!empty" class="filter">
      <Icon name="search" :size="12" class="filter-icon" />
      <input
        v-model="query"
        class="filter-input"
        placeholder="Filter projects, connections, databases"
        spellcheck="false"
        @keydown.esc="query = ''"
      />
      <button v-if="query" class="btn-ghost icon filter-clear" title="Clear filter" @click="query = ''"><Icon name="x" :size="11" /></button>
    </div>

    <div class="tree">
      <div v-if="!empty && needle && !tree.length" class="hint-row muted no-match">No matches for “{{ query.trim() }}”.</div>
      <div v-if="empty" class="empty">
        <p v-if="multiWorkspace && ws.activeWorkspace">No projects for {{ ws.activeWorkspace.name }} yet.</p>
        <p v-else>No projects yet.</p>
        <button class="btn btn-primary" @click="emit('newProject')">Create your first project</button>
      </div>

      <div v-for="{ project, envs, open: projectOpen } in tree" :key="project.id" class="project">
        <div
          class="row project-row"
          @click="ws.toggleProject(project.id)"
          @contextmenu.prevent="openProjectMenu($event, project)"
        >
          <span class="caret" :class="{ open: projectOpen }"><Icon name="chevronRight" :size="11" /></span>
          <span class="label">{{ project.name }}</span>
          <div class="row-actions" @click.stop>
            <button class="btn-ghost icon" title="New environment" @click="emit('newEnvironment', project.id)"><Icon name="plus" :size="13" /></button>
            <button class="btn-ghost icon" title="Rename" @click="emit('editProject', project)"><Icon name="pencil" :size="12" /></button>
            <button class="btn-ghost icon danger" title="Delete" @click="emit('deleteProject', project)"><Icon name="trash" :size="12" /></button>
          </div>
        </div>

        <div v-show="projectOpen" class="children">
          <div v-if="project.environments.length === 0" class="hint-row">
            <button class="link" @click="emit('newEnvironment', project.id)">+ Add environment</button>
          </div>

          <div v-for="{ env, conns, open: envOpen } in envs" :key="env.id" class="env">
            <div class="row env-row" @click="ws.toggleEnv(env.id)">
              <span class="caret" :class="{ open: envOpen }"><Icon name="chevronRight" :size="11" /></span>
              <span class="folder"><Icon name="folder" :size="12" /></span>
              <span class="label">{{ env.name }}</span>
              <div class="row-actions" @click.stop>
                <button class="btn-ghost icon" title="New connection" @click="emit('newConnection', env.id)"><Icon name="plus" :size="13" /></button>
                <button class="btn-ghost icon" title="Rename" @click="emit('editEnvironment', env)"><Icon name="pencil" :size="12" /></button>
                <button class="btn-ghost icon danger" title="Delete" @click="emit('deleteEnvironment', env)"><Icon name="trash" :size="12" /></button>
              </div>
            </div>

            <div v-show="envOpen" class="children">
              <div v-if="env.connections.length === 0" class="hint-row">
                <button class="link" @click="emit('newConnection', env.id)">+ Add connection</button>
              </div>
              <template v-for="{ conn, databases, open: serverOpen } in conns" :key="conn.id">
              <div
                class="row conn-row"
                :class="{ active: ws.activeConnectionId === conn.id, server: conn.serverMode }"
                @click="conn.serverMode ? openServer(conn) : open(conn)"
              >
                <span
                  v-if="conn.serverMode"
                  class="caret server-caret"
                  :class="{ open: serverOpen }"
                  title="Show or hide databases"
                  @click.stop="ws.toggleServer(conn.id)"
                ><Icon name="chevronRight" :size="11" /></span>
                <span v-if="conn.serverMode" class="conn-icon" :style="{ color: conn.color || 'var(--text-faint)' }"><Icon name="server" :size="13" /></span>
                <span v-else-if="explorer" class="conn-icon" :style="{ color: conn.color || 'var(--text-faint)' }"><Icon name="database" :size="13" /></span>
                <span v-else class="dot" :style="{ background: conn.color || 'var(--text-faint)' }" />
                <span class="label">{{ conn.name }}</span>
                <ConnTaskIndicator :conn-id="conn.id" />
                <span class="badge">{{ DRIVER_LABEL[conn.driver] }}</span>
                <span
                  class="state"
                  :class="ws.connStates[conn.id] || 'disconnected'"
                  :title="stateTitle(conn.id)"
                />
                <div class="row-actions" @click.stop>
                  <button v-if="conn.serverMode" class="btn-ghost icon" title="Refresh databases" @click="ws.loadServerDatabases(conn.id)"><Icon name="refresh" :size="12" /></button>
                  <button class="btn-ghost icon" title="Duplicate" @click="emit('duplicateConnection', conn)"><Icon name="copy" :size="12" /></button>
                  <button class="btn-ghost icon" title="Edit" @click="emit('editConnection', conn, env.id)"><Icon name="pencil" :size="12" /></button>
                  <button class="btn-ghost icon danger" title="Delete" @click="emit('deleteConnection', conn)"><Icon name="trash" :size="12" /></button>
                </div>
              </div>
              <div v-if="conn.serverMode" v-show="serverOpen" class="children server-dbs">
                <input
                  v-if="(ws.serverDatabases[conn.id]?.length ?? 0) > DB_FILTER_THRESHOLD"
                  v-model="dbFilter[conn.id]"
                  class="input db-filter"
                  placeholder="Filter databases…"
                  @keydown.esc="dbFilter[conn.id] = ''"
                />
                <div v-if="ws.serverLoading[conn.id] && !ws.serverDatabases[conn.id]" class="hint-row muted">Loading databases…</div>
                <div v-else-if="ws.serverErrors[conn.id]" class="hint-row error" :title="ws.serverErrors[conn.id]">
                  Could not list databases.
                  <button class="link" @click="ws.loadServerDatabases(conn.id)">Retry</button>
                </div>
                <div v-else-if="ws.serverDatabases[conn.id]?.length === 0" class="hint-row muted">No databases.</div>
                <div
                  v-for="db in databases"
                  :key="db"
                  class="row conn-row db-row"
                  :class="{ active: ws.activeConnectionId === serverDatabaseId(conn.id, db) }"
                  @click="ws.connectAndOpen(serverDatabaseId(conn.id, db))"
                >
                  <span class="conn-icon db-icon"><Icon name="database" :size="12" /></span>
                  <span class="label">{{ db }}</span>
                  <ConnTaskIndicator :conn-id="serverDatabaseId(conn.id, db)" />
                  <span
                    class="state"
                    :class="ws.connStates[serverDatabaseId(conn.id, db)] || 'disconnected'"
                    :title="stateTitle(serverDatabaseId(conn.id, db))"
                  />
                </div>
              </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Replication topologies (Phase 1: live monitoring) -->
    <div class="topo-section">
      <div class="topo-head">
        <span class="topo-title">Topologies</span>
        <button class="btn-ghost icon" title="New topology" @click="emit('newTopology')"><Icon name="plus" :size="13" /></button>
      </div>
      <div
        v-for="t in ws.topologies"
        :key="t.id"
        class="row topo-row"
        :class="{ active: ui.topologyId === t.id }"
        @click="ui.openTopology(t.id)"
      >
        <span v-if="explorer" class="caret"><Icon name="chevronRight" :size="11" style="visibility: hidden" /></span>
        <span class="topo-dot"><Icon name="diagram" :size="12" /></span>
        <span class="topo-name">{{ t.name }}</span>
        <span class="topo-count">{{ t.nodes.length }}</span>
        <div class="row-actions" @click.stop>
          <button class="btn-ghost icon" title="Edit" @click="emit('editTopology', t)"><Icon name="pencil" :size="12" /></button>
          <button class="btn-ghost icon danger" title="Delete" @click="emit('deleteTopology', t)"><Icon name="trash" :size="12" /></button>
        </div>
      </div>
      <p v-if="!ws.topologies.length" class="topo-empty">
        Group replicas into a set to watch live lag & health.
      </p>
    </div>

    <ContextMenu v-if="ctx" :x="ctx.x" :y="ctx.y" :items="ctx.items" @close="ctx = null" />
  </aside>
</template>

<style scoped>
.sidebar {
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.side-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 8px 14px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}
.logo {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  -webkit-app-region: no-drag;
}
.brand {
  font-weight: 700;
  letter-spacing: 0.02em;
  font-size: 13px;
  flex: 1;
  margin-right: auto;
}
.side-head .icon + .icon {
  margin-left: -4px;
}
.side-head .icon {
  -webkit-app-region: no-drag;
}
.workspace-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 6px 6px 0;
  padding: 0 8px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text);
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-1);
}
.workspace-row:hover {
  background: var(--bg-hover);
}
.workspace-icon,
.workspace-caret {
  display: inline-flex;
  align-items: center;
  color: var(--text-faint);
  flex-shrink: 0;
}
.workspace-name {
  flex: 1;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tree {
  flex: 1;
  overflow-y: auto;
  padding: 6px 6px 20px;
}
.empty {
  text-align: center;
  padding: 40px 16px;
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  position: relative;
  transition: background var(--dur-1);
}
.row:hover {
  background: var(--bg-hover);
}
.conn-row.active {
  background: var(--accent-soft);
}
.conn-row.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 2.5px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}
.conn-row.active .label {
  color: var(--text);
  font-weight: 500;
}
.caret {
  width: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  transition: transform var(--dur-2) var(--ease-out);
  flex-shrink: 0;
}
.caret.open {
  transform: rotate(90deg);
}
.folder {
  display: inline-flex;
  align-items: center;
  color: var(--text-faint);
  flex-shrink: 0;
}
.label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-row .label {
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-dim);
}
.children {
  padding-left: 14px;
  /* v-show re-triggers this on every expand: a quick settle-in for the subtree. */
  animation: kids-in var(--dur-2) var(--ease-out);
}
@keyframes kids-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}
.badge {
  font-size: 9px;
  font-weight: 700;
  color: var(--text-faint);
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
}
.state {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-faint);
}
.state.connected {
  background: var(--ok);
  box-shadow: 0 0 6px var(--ok);
}
.state.connecting,
.state.reconnecting {
  background: var(--warn);
  animation: pulse 0.9s infinite;
}
.state.unhealthy {
  background: var(--danger);
  animation: pulse 0.9s infinite;
}
.state.error {
  background: var(--danger);
}
.state.idle {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--ok);
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
/* Hover actions float in a small pill on the right instead of pushing the
   label/badges around — the row's layout never shifts. */
.row-actions {
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 1px;
  border-radius: 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-1);
}
.row:hover .row-actions,
.row:focus-within .row-actions {
  opacity: 1;
  pointer-events: auto;
}
.icon {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  color: var(--text-dim);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--dur-1), color var(--dur-1);
}
.icon:hover {
  background: var(--bg-active);
  color: var(--text);
}
.icon.danger:hover {
  color: var(--danger);
}
.hint-row {
  padding: 2px 8px 4px 26px;
}
.hint-row.muted {
  color: var(--text-faint);
  font-size: 12px;
}
.hint-row.error {
  color: var(--danger);
  font-size: 12px;
}
.db-icon {
  display: inline-flex;
  align-items: center;
  color: var(--text-faint);
  flex-shrink: 0;
}
.db-filter {
  width: calc(100% - 16px);
  margin: 2px 8px 4px;
  height: 24px;
  font-size: 12px;
}
.explorer .db-row {
  --indent: 56px;
}
.explorer .server-dbs > .hint-row {
  padding-left: 56px;
}
.explorer .server-dbs > .db-filter {
  margin-left: 56px;
  width: calc(100% - 64px);
}
.explorer .server-dbs::before {
  left: 43px;
}
.explorer .conn-row.server {
  --indent: 22px;
}
.conn-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
.server-caret {
  height: 100%;
}
.filter {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 6px 0;
  padding: 0 4px 0 8px;
  height: 26px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  transition: border-color var(--dur-1);
}
.filter:focus-within {
  border-color: var(--accent);
}
.filter-icon {
  color: var(--text-faint);
  flex-shrink: 0;
}
.filter-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
}
.filter-input::placeholder {
  color: var(--text-faint);
}
.filter-clear {
  width: 18px;
  height: 18px;
}
.no-match {
  padding: 10px 12px;
}
.explorer .filter {
  margin: 0;
  height: 26px;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
}
/* ---- topologies footer section ---- */
.topo-section {
  border-top: 1px solid var(--border);
  padding: 6px 6px 10px;
  max-height: 40%;
  overflow-y: auto;
  flex-shrink: 0;
}
.topo-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 6px;
}
.topo-title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.topo-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.topo-row:hover {
  background: var(--bg-hover);
}
.topo-row.active {
  background: var(--accent-soft);
}
.topo-dot {
  display: inline-flex;
  align-items: center;
  color: var(--accent);
  flex-shrink: 0;
}
.topo-name {
  flex: 1;
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.topo-count {
  font-size: 11px;
  color: var(--text-faint);
  background: var(--bg-elevated);
  border-radius: 9px;
  padding: 0 6px;
}
.topo-row:hover .topo-count {
  opacity: 0;
}
.topo-count {
  transition: opacity var(--dur-1);
}
.topo-empty {
  padding: 2px 10px 6px;
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.5;
}
.link {
  color: var(--text-faint);
  font-size: 12px;
}
.link:hover {
  color: var(--accent);
}
/* ---- Explorer layout: a flat, dense tree with indent guides, in the style of
   a file explorer. Every rule below only narrows the comfortable layout. ---- */
/* Only the vertical/right padding tightens; the left padding stays as set
   globally (it clears the macOS traffic lights). */
.explorer .side-head {
  padding-top: 6px;
  padding-bottom: 6px;
  padding-right: 8px;
  min-height: 36px;
}
.explorer .brand {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.explorer .workspace-row {
  margin: 0;
  height: 26px;
  padding: 0 10px;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
}
.explorer .workspace-name {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.explorer .tree {
  padding: 4px 0 16px;
}
.explorer .empty {
  padding: 28px 12px;
}
.explorer .row {
  height: 22px;
  gap: 5px;
  padding: 0 8px 0 var(--indent, 8px);
  border-radius: 0;
  font-size: 12px;
}
.explorer .project-row {
  --indent: 8px;
}
.explorer .project-row .label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  color: var(--text);
}
.explorer .env-row {
  --indent: 20px;
}
.explorer .conn-row {
  --indent: 38px;
}
.explorer .conn-row .label {
  color: var(--text-dim);
}
.explorer .conn-row:hover .label,
.explorer .conn-row.active .label {
  color: var(--text);
}
.explorer .conn-row.active {
  background: var(--bg-active);
}
.explorer .conn-row.active::before {
  top: 0;
  bottom: 0;
  width: 2px;
  border-radius: 0;
}
.explorer .children {
  position: relative;
  padding-left: 0;
}
.explorer .children::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 13px;
  width: 1px;
  background: var(--border-strong);
  opacity: 0.6;
  pointer-events: none;
}
.explorer .env > .children::before {
  left: 25px;
}
.explorer .caret {
  width: 11px;
}
.explorer .folder {
  color: var(--text-dim);
}
.explorer .conn-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
.explorer .badge {
  padding: 0;
  background: transparent;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.explorer .row-actions {
  right: 4px;
  padding: 0;
  gap: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.explorer .row:hover .badge,
.explorer .row:hover .state,
.explorer .row:focus-within .badge,
.explorer .row:focus-within .state {
  opacity: 0;
}
.explorer .badge,
.explorer .state {
  transition: opacity var(--dur-1);
}
.explorer .icon {
  width: 18px;
  height: 18px;
  border-radius: 3px;
}
.explorer .project > .children > .hint-row {
  padding: 1px 8px 2px 20px;
}
.explorer .env > .children > .hint-row {
  padding: 1px 8px 2px 38px;
}
.explorer .topo-section {
  padding: 0 0 8px;
}
.explorer .topo-head {
  height: 24px;
  padding: 0 8px;
}
.explorer .topo-row {
  height: 22px;
  gap: 5px;
  padding: 0 8px;
  border-radius: 0;
  font-size: 12px;
}
.explorer .topo-row.active {
  background: var(--bg-active);
}
.explorer .topo-name {
  font-size: 12px;
}
.explorer .topo-empty {
  padding: 2px 8px 4px 22px;
}
</style>
