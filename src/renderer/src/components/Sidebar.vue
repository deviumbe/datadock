<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWorkspace } from '../stores/workspace'
import { useUi } from '../stores/ui'
import type { Workspace, ConnectionConfig, Environment, Project, Topology } from '@shared/types'
import logoUrl from '../assets/logo.png'
import Icon from './Icon.vue'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'

const ws = useWorkspace()
const ui = useUi()

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

const STATE_LABEL: Record<string, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  unhealthy: 'Connection lost',
  error: 'Connection failed'
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
  <aside class="sidebar">
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

    <div class="tree">
      <div v-if="empty" class="empty">
        <p v-if="multiWorkspace && ws.activeWorkspace">No projects for {{ ws.activeWorkspace.name }} yet.</p>
        <p v-else>No projects yet.</p>
        <button class="btn btn-primary" @click="emit('newProject')">Create your first project</button>
      </div>

      <div v-for="project in ws.projects" :key="project.id" class="project">
        <div
          class="row project-row"
          @click="ws.toggleProject(project.id)"
          @contextmenu.prevent="openProjectMenu($event, project)"
        >
          <span class="caret" :class="{ open: ws.expandedProjects.has(project.id) }"><Icon name="chevronRight" :size="11" /></span>
          <span class="label">{{ project.name }}</span>
          <div class="row-actions" @click.stop>
            <button class="btn-ghost icon" title="New environment" @click="emit('newEnvironment', project.id)"><Icon name="plus" :size="13" /></button>
            <button class="btn-ghost icon" title="Rename" @click="emit('editProject', project)"><Icon name="pencil" :size="12" /></button>
            <button class="btn-ghost icon danger" title="Delete" @click="emit('deleteProject', project)"><Icon name="trash" :size="12" /></button>
          </div>
        </div>

        <div v-show="ws.expandedProjects.has(project.id)" class="children">
          <div v-if="project.environments.length === 0" class="hint-row">
            <button class="link" @click="emit('newEnvironment', project.id)">+ Add environment</button>
          </div>

          <div v-for="env in project.environments" :key="env.id" class="env">
            <div class="row env-row" @click="ws.toggleEnv(env.id)">
              <span class="caret" :class="{ open: ws.expandedEnvs.has(env.id) }"><Icon name="chevronRight" :size="11" /></span>
              <span class="folder"><Icon name="folder" :size="12" /></span>
              <span class="label">{{ env.name }}</span>
              <div class="row-actions" @click.stop>
                <button class="btn-ghost icon" title="New connection" @click="emit('newConnection', env.id)"><Icon name="plus" :size="13" /></button>
                <button class="btn-ghost icon" title="Rename" @click="emit('editEnvironment', env)"><Icon name="pencil" :size="12" /></button>
                <button class="btn-ghost icon danger" title="Delete" @click="emit('deleteEnvironment', env)"><Icon name="trash" :size="12" /></button>
              </div>
            </div>

            <div v-show="ws.expandedEnvs.has(env.id)" class="children">
              <div v-if="env.connections.length === 0" class="hint-row">
                <button class="link" @click="emit('newConnection', env.id)">+ Add connection</button>
              </div>
              <div
                v-for="conn in env.connections"
                :key="conn.id"
                class="row conn-row"
                :class="{ active: ws.activeConnectionId === conn.id }"
                @click="open(conn)"
              >
                <span class="dot" :style="{ background: conn.color || 'var(--text-faint)' }" />
                <span class="label">{{ conn.name }}</span>
                <span class="badge">{{ DRIVER_LABEL[conn.driver] }}</span>
                <span
                  class="state"
                  :class="ws.connStates[conn.id] || 'disconnected'"
                  :title="stateTitle(conn.id)"
                />
                <div class="row-actions" @click.stop>
                  <button class="btn-ghost icon" title="Duplicate" @click="emit('duplicateConnection', conn)"><Icon name="copy" :size="12" /></button>
                  <button class="btn-ghost icon" title="Edit" @click="emit('editConnection', conn, env.id)"><Icon name="pencil" :size="12" /></button>
                  <button class="btn-ghost icon danger" title="Delete" @click="emit('deleteConnection', conn)"><Icon name="trash" :size="12" /></button>
                </div>
              </div>
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
  justify-content: space-between;
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
</style>
