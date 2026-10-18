<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Modal from './Modal.vue'
import Icon from './Icon.vue'
import { useWorkspace } from '../stores/workspace'
import type { DataGripImportResult, DataGripPlannedConnection, DataGripPreview } from '@shared/types'
import { DRIVERS } from '@shared/types'

const emit = defineEmits<{ close: [] }>()
const ws = useWorkspace()

const folder = ref('')
const workspaceId = ref(ws.activeWorkspaceId ?? ws.workspaces[0]?.id ?? '')
const preview = ref<DataGripPreview>()
const selected = ref(new Set<string>())
const loading = ref(false)
const importing = ref(false)
const error = ref('')
const result = ref<DataGripImportResult>()

onMounted(() => void chooseFolder())

async function chooseFolder(): Promise<void> {
  const picked = await window.api.datagrip.pickFolder()
  if (picked.canceled || !picked.folder) {
    if (!preview.value) emit('close')
    return
  }
  folder.value = picked.folder
  await load()
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    preview.value = await window.api.datagrip.preview(folder.value, workspaceId.value || undefined)
    workspaceId.value = preview.value.workspaceId
    selected.value = new Set(allConnections.value.filter((c) => c.status === 'new').map((c) => c.sourceId))
  } catch (err) {
    preview.value = undefined
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

async function onWorkspaceChange(e: Event): Promise<void> {
  workspaceId.value = (e.target as HTMLSelectElement).value
  await load()
}

const allConnections = computed<DataGripPlannedConnection[]>(() =>
  (preview.value?.projects ?? []).flatMap((p) => p.environments.flatMap((e) => e.connections))
)
const selectableCount = computed(() => allConnections.value.filter((c) => c.status === 'new').length)
const selectedCount = computed(() => selected.value.size)
const workspaceName = computed(
  () => ws.workspaces.find((w) => w.id === workspaceId.value)?.name ?? preview.value?.projectName ?? ''
)

function toggle(c: DataGripPlannedConnection): void {
  if (c.status !== 'new') return
  const next = new Set(selected.value)
  next.has(c.sourceId) ? next.delete(c.sourceId) : next.add(c.sourceId)
  selected.value = next
}
function setAll(on: boolean): void {
  selected.value = on
    ? new Set(allConnections.value.filter((c) => c.status === 'new').map((c) => c.sourceId))
    : new Set()
}
function projectState(connections: DataGripPlannedConnection[]): 'all' | 'some' | 'none' {
  const eligible = connections.filter((c) => c.status === 'new')
  const on = eligible.filter((c) => selected.value.has(c.sourceId)).length
  if (!eligible.length || on === 0) return 'none'
  return on === eligible.length ? 'all' : 'some'
}
function toggleGroup(connections: DataGripPlannedConnection[]): void {
  const turnOn = projectState(connections) !== 'all'
  const next = new Set(selected.value)
  for (const c of connections) {
    if (c.status !== 'new') continue
    turnOn ? next.add(c.sourceId) : next.delete(c.sourceId)
  }
  selected.value = next
}

function driverLabel(driver: string): string {
  return DRIVERS.find((d) => d.type === driver)?.label ?? driver
}
function endpoint(c: DataGripPlannedConnection): string {
  if (c.filePath) return c.filePath
  const host = c.host ?? ''
  const port = c.port ? `:${c.port}` : ''
  const db = c.database ? `/${c.database}` : ''
  return `${host}${port}${db}`
}

async function runImport(): Promise<void> {
  if (!preview.value || importing.value) return
  importing.value = true
  error.value = ''
  try {
    const res = await window.api.datagrip.import(folder.value, workspaceId.value || undefined, [...selected.value])
    ws.applyImportedCatalog(res.catalog)
    result.value = res
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <Modal title="Import from DataGrip" size="lg" :busy="importing" @close="emit('close')">
    <div v-if="result" class="done">
      <span class="done-ic"><Icon name="check" :size="22" /></span>
      <div>
        <p class="done-title">
          Imported {{ result.imported }} connection{{ result.imported === 1 ? '' : 's' }} into
          <b>{{ workspaceName }}</b>.
        </p>
        <p v-if="result.sshProfilesCreated" class="dim">
          {{ result.sshProfilesCreated }} SSH profile{{ result.sshProfilesCreated === 1 ? '' : 's' }} created in Settings.
        </p>
        <p class="dim">
          Passwords were not imported. DataDock asks for them the first time you connect.
        </p>
      </div>
    </div>

    <template v-else>
      <div class="source">
        <div class="source-path">
          <Icon name="folder" :size="14" />
          <span class="path" :title="folder">{{ folder || 'No folder chosen' }}</span>
        </div>
        <button class="btn" :disabled="loading" @click="chooseFolder">Choose folder…</button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="loading" class="dim">Reading the DataGrip project…</p>

      <template v-else-if="preview">
        <div class="target">
          <div class="field">
            <label>Import into workspace</label>
            <select v-if="ws.workspaces.length" class="select" :value="workspaceId" @change="onWorkspaceChange">
              <option v-for="w in ws.workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
            </select>
            <span v-else class="new-workspace">New workspace "{{ preview.projectName }}"</span>
          </div>
          <div class="counts">
            <span><b>{{ preview.counts.sources }}</b> data sources</span>
            <span><b>{{ preview.counts.new }}</b> new</span>
            <span v-if="preview.counts.duplicates"><b>{{ preview.counts.duplicates }}</b> already present</span>
            <span v-if="preview.counts.skipped"><b>{{ preview.counts.skipped }}</b> skipped</span>
          </div>
        </div>

        <div class="tree-head">
          <span class="dim">{{ selectedCount }} of {{ selectableCount }} selected</span>
          <span class="tree-actions">
            <button class="btn btn-ghost small" @click="setAll(true)">Select all</button>
            <button class="btn btn-ghost small" @click="setAll(false)">Select none</button>
          </span>
        </div>

        <div class="tree">
          <div v-for="p in preview.projects" :key="p.name" class="project">
            <label class="node project-node">
              <input
                type="checkbox"
                :checked="projectState(p.environments.flatMap((e) => e.connections)) === 'all'"
                :indeterminate="projectState(p.environments.flatMap((e) => e.connections)) === 'some'"
                @change="toggleGroup(p.environments.flatMap((e) => e.connections))"
              />
              <span class="name">{{ p.name }}</span>
              <span v-if="p.exists" class="tag">existing project</span>
            </label>
            <div v-for="e in p.environments" :key="e.name" class="env">
              <label class="node env-node">
                <input
                  type="checkbox"
                  :checked="projectState(e.connections) === 'all'"
                  :indeterminate="projectState(e.connections) === 'some'"
                  @change="toggleGroup(e.connections)"
                />
                <span class="name">{{ e.name }}</span>
                <span v-if="e.exists" class="tag">existing</span>
              </label>
              <label
                v-for="c in e.connections"
                :key="c.sourceId"
                class="node conn"
                :class="{ off: c.status !== 'new' }"
              >
                <input
                  type="checkbox"
                  :disabled="c.status !== 'new'"
                  :checked="selected.has(c.sourceId)"
                  @change="toggle(c)"
                />
                <span class="conn-main">
                  <span class="name">{{ c.name }}</span>
                  <span class="meta">
                    {{ driverLabel(c.driver) }}
                    <span class="sep">·</span>
                    <span class="mono">{{ endpoint(c) }}</span>
                    <template v-if="c.user">
                      <span class="sep">·</span>
                      {{ c.user }}
                    </template>
                    <template v-if="c.sshProfile">
                      <span class="sep">·</span>
                      SSH {{ c.sshProfile }}
                    </template>
                  </span>
                  <span v-if="c.status === 'duplicate'" class="note">
                    Already present as {{ c.duplicateOf }}
                  </span>
                  <span v-for="w in c.warnings" :key="w" class="note warn">
                    <Icon name="warn" :size="11" /> {{ w }}
                  </span>
                </span>
                <span v-if="c.production" class="tag prod">production</span>
              </label>
            </div>
          </div>
          <p v-if="!preview.projects.length" class="dim empty">No data sources found in this project.</p>
        </div>

        <div class="summary">
          <div v-if="preview.sshProfiles.length" class="block">
            <h4>SSH profiles</h4>
            <ul>
              <li v-for="s in preview.sshProfiles" :key="s.host + s.user">
                <span class="mono">{{ s.user }}@{{ s.host }}</span>
                <span class="dim"> — {{ s.exists ? `reuses "${s.name}"` : `new profile "${s.name}"` }}</span>
              </li>
            </ul>
          </div>
          <div v-if="preview.skipped.length" class="block">
            <h4>Skipped</h4>
            <ul>
              <li v-for="s in preview.skipped" :key="s.name">
                <b>{{ s.name }}</b> <span class="dim">— {{ s.reason }}</span>
              </li>
            </ul>
          </div>
          <div class="block">
            <ul class="notes">
              <li v-for="n in preview.notes" :key="n"><Icon name="info" :size="12" /> {{ n }}</li>
            </ul>
          </div>
        </div>
      </template>
    </template>

    <template #footer>
      <template v-if="result">
        <button class="btn btn-primary" @click="emit('close')">Done</button>
      </template>
      <template v-else>
        <button class="btn btn-ghost" :disabled="importing" @click="emit('close')">Cancel</button>
        <button
          class="btn btn-primary"
          :disabled="!preview || !selectedCount || importing || loading"
          @click="runImport"
        >
          {{ importing ? 'Importing…' : `Import ${selectedCount} connection${selectedCount === 1 ? '' : 's'}` }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.source {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.source-path {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--text-dim);
}
.path {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.target {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.target .field {
  min-width: 260px;
}
.new-workspace {
  font-size: 13px;
  padding: 8px 0;
}
.counts {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--text-dim);
  padding-bottom: 8px;
}
.counts b {
  color: var(--text);
}
.tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  margin-bottom: 6px;
}
.tree-actions {
  display: flex;
  gap: 2px;
}
.btn.small {
  padding: 3px 8px;
  font-size: 12px;
}
.tree {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  max-height: 44vh;
  overflow: auto;
  padding: 6px 0;
  background: var(--bg-input);
}
.project + .project {
  border-top: 1px solid var(--border-soft);
  margin-top: 4px;
  padding-top: 4px;
}
.node {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}
.node:hover {
  background: var(--bg-hover);
}
.node input {
  margin-top: 3px;
  flex: none;
}
.project-node {
  font-weight: 600;
}
.env-node {
  padding-left: 32px;
  color: var(--text-dim);
  font-weight: 500;
}
.conn {
  padding-left: 52px;
}
.conn.off {
  cursor: default;
  opacity: 0.6;
}
.conn-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 11.5px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sep {
  margin: 0 5px;
  color: var(--text-faint);
}
.mono {
  font-family: var(--mono);
}
.note {
  font-size: 11.5px;
  color: var(--text-faint);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.note.warn {
  color: var(--warn);
}
.tag {
  flex: none;
  align-self: center;
  font-size: 10.5px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  text-transform: lowercase;
}
.tag.prod {
  border-color: transparent;
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}
.summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 14px;
  font-size: 12.5px;
}
.block h4 {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.block ul {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.notes li {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
}
.dim {
  color: var(--text-dim);
  font-size: 12.5px;
}
.empty {
  padding: 18px;
  text-align: center;
}
.error {
  color: var(--danger);
  font-size: 13px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
  border-radius: var(--radius-sm);
}
.done {
  display: flex;
  gap: 13px;
  align-items: flex-start;
  min-width: 420px;
}
.done-ic {
  color: var(--ok);
  display: inline-flex;
  flex: none;
}
.done-title {
  font-size: 13.5px;
  margin-bottom: 6px;
}
</style>
