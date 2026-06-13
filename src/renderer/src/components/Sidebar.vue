<script setup lang="ts">
import { computed } from 'vue'
import { useWorkspace } from '../stores/workspace'
import type { ConnectionConfig, Environment, Project } from '@shared/types'
import logoUrl from '../assets/logo.png'

const ws = useWorkspace()

const emit = defineEmits<{
  newProject: []
  editProject: [project: Project]
  deleteProject: [project: Project]
  newEnvironment: [projectId: string]
  editEnvironment: [env: Environment]
  deleteEnvironment: [env: Environment]
  newConnection: [environmentId: string]
  editConnection: [conn: ConnectionConfig, environmentId: string]
  deleteConnection: [conn: ConnectionConfig]
  duplicateConnection: [conn: ConnectionConfig]
}>()

const empty = computed(() => ws.projects.length === 0)

function open(conn: ConnectionConfig): void {
  ws.connectAndOpen(conn.id)
}

const DRIVER_LABEL: Record<string, string> = {
  postgres: 'PG',
  mysql: 'SQL',
  sqlite: 'LITE',
  mssql: 'MS',
  influxdb: 'IFX'
}
</script>

<template>
  <aside class="sidebar">
    <div class="side-head">
      <img class="logo" :src="logoUrl" alt="DataDock" />
      <span class="brand">DataDock</span>
      <button class="btn-ghost icon" title="New project" @click="emit('newProject')">＋</button>
    </div>

    <div class="tree">
      <div v-if="empty" class="empty">
        <p>No projects yet.</p>
        <button class="btn btn-primary" @click="emit('newProject')">Create your first project</button>
      </div>

      <div v-for="project in ws.projects" :key="project.id" class="project">
        <div class="row project-row" @click="ws.toggleProject(project.id)">
          <span class="caret" :class="{ open: ws.expandedProjects.has(project.id) }">▸</span>
          <span class="label">{{ project.name }}</span>
          <div class="row-actions" @click.stop>
            <button class="btn-ghost icon" title="New environment" @click="emit('newEnvironment', project.id)">＋</button>
            <button class="btn-ghost icon" title="Rename" @click="emit('editProject', project)">✎</button>
            <button class="btn-ghost icon danger" title="Delete" @click="emit('deleteProject', project)">🗑</button>
          </div>
        </div>

        <div v-show="ws.expandedProjects.has(project.id)" class="children">
          <div v-if="project.environments.length === 0" class="hint-row">
            <button class="link" @click="emit('newEnvironment', project.id)">+ Add environment</button>
          </div>

          <div v-for="env in project.environments" :key="env.id" class="env">
            <div class="row env-row" @click="ws.toggleEnv(env.id)">
              <span class="caret" :class="{ open: ws.expandedEnvs.has(env.id) }">▸</span>
              <span class="folder">▤</span>
              <span class="label">{{ env.name }}</span>
              <div class="row-actions" @click.stop>
                <button class="btn-ghost icon" title="New connection" @click="emit('newConnection', env.id)">＋</button>
                <button class="btn-ghost icon" title="Rename" @click="emit('editEnvironment', env)">✎</button>
                <button class="btn-ghost icon danger" title="Delete" @click="emit('deleteEnvironment', env)">🗑</button>
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
                <span class="dot" :style="{ background: conn.color || '#888f9c' }" />
                <span class="label">{{ conn.name }}</span>
                <span class="badge">{{ DRIVER_LABEL[conn.driver] }}</span>
                <span
                  class="state"
                  :class="ws.connStates[conn.id] || 'disconnected'"
                  :title="ws.connStates[conn.id] || 'disconnected'"
                />
                <div class="row-actions" @click.stop>
                  <button class="btn-ghost icon" title="Duplicate" @click="emit('duplicateConnection', conn)">⎘</button>
                  <button class="btn-ghost icon" title="Edit" @click="emit('editConnection', conn, env.id)">✎</button>
                  <button class="btn-ghost icon danger" title="Delete" @click="emit('deleteConnection', conn)">🗑</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
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
}
.row:hover {
  background: var(--bg-hover);
}
.conn-row.active {
  background: var(--accent-soft);
}
.caret {
  width: 12px;
  font-size: 9px;
  color: var(--text-faint);
  transition: transform 0.12s;
  flex-shrink: 0;
}
.caret.open {
  transform: rotate(90deg);
}
.folder {
  color: var(--text-faint);
  font-size: 11px;
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
.state.connecting {
  background: var(--warn);
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
.row-actions {
  display: none;
  align-items: center;
  gap: 1px;
}
.row:hover .row-actions {
  display: flex;
}
.icon {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-dim);
  display: inline-flex;
  align-items: center;
  justify-content: center;
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
.link {
  color: var(--text-faint);
  font-size: 12px;
}
.link:hover {
  color: var(--accent);
}
</style>
