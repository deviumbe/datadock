<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useWorkspace } from '../stores/workspace'
import { useTabs, type Tab } from '../stores/tabs'
import { useUi } from '../stores/ui'
import SqlEditor from './SqlEditor.vue'
import ResultsGrid from './ResultsGrid.vue'
import RowDetailPanel from './RowDetailPanel.vue'
import StructurePanel from './StructurePanel.vue'
import FilterBar from './FilterBar.vue'
import ExportModal from './ExportModal.vue'
import ExportDbModal from './ExportDbModal.vue'
import ImportModal from './ImportModal.vue'
import { type FilterSpec, type TableInfo } from '@shared/types'
import logoUrl from '../assets/logo.png'

const ws = useWorkspace()
const tabsStore = useTabs()
const ui = useUi()

const tableFilter = ref('')
const newDbName = ref('')

const exportOpen = ref(false)

const activeConn = computed(() =>
  ws.activeConnectionId ? ws.findConnection(ws.activeConnectionId) : undefined
)
const isInflux = computed(() => activeConn.value?.driver === 'influxdb')

const connTabs = computed(() =>
  ws.activeConnectionId ? tabsStore.forConnection(ws.activeConnectionId) : []
)
const active = computed(() =>
  ws.activeConnectionId ? tabsStore.activeTab(ws.activeConnectionId) : null
)

const filteredTables = computed(() => {
  const f = tableFilter.value.toLowerCase().trim()
  return f ? ws.tables.filter((t) => t.name.toLowerCase().includes(f)) : ws.tables
})

watch(
  () => (ws.activeConnectionId ? ws.connStates[ws.activeConnectionId] : null),
  (state) => {
    const id = ws.activeConnectionId
    if (id && state === 'connected' && tabsStore.forConnection(id).length === 0) {
      tabsStore.openQuery(id)
    }
  }
)

function inEditableField(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function onKeydown(e: KeyboardEvent): void {
  const a = active.value

  // Undo / redo of draft row edits — but let inputs and the SQL editor handle their own.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    if (inEditableField()) return
    if (!a || a.kind !== 'table') return
    e.preventDefault()
    if (e.shiftKey) tabsStore.redo(a)
    else tabsStore.undo(a)
    return
  }

  // Backspace / Delete marks the selected data row for deletion (unless typing in a field).
  if (e.key !== 'Backspace' && e.key !== 'Delete') return
  if (!a || a.kind !== 'table' || a.viewMode !== 'data' || a.selectedRow === null) return
  if (!tabsStore.editsAllowed(a)) return
  if (inEditableField()) return
  e.preventDefault()
  tabsStore.toggleDelete(a, a.selectedRow)
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function openTable(t: TableInfo): void {
  if (ws.activeConnectionId) tabsStore.openTable(ws.activeConnectionId, t)
}
function newQuery(): void {
  if (ws.activeConnectionId) tabsStore.openQuery(ws.activeConnectionId)
}
async function disconnect(): Promise<void> {
  if (ws.activeConnectionId) await ws.disconnect(ws.activeConnectionId)
}

// pagination helpers
const pageInfo = (tab: Tab): string => {
  const n = tab.result?.rows.length ?? 0
  if (n === 0) return tab.offset > 0 ? `from ${tab.offset + 1}` : '0 rows'
  return `${tab.offset + 1}–${tab.offset + n}`
}
function onApplyFilters(tab: Tab, filters: FilterSpec[]): void {
  tabsStore.setFilters(tab, filters)
}

// databases panel
async function createDatabase(tab: Tab): Promise<void> {
  const name = newDbName.value.trim()
  if (!name) return
  try {
    await window.api.db.createDatabase(tab.connectionId, name)
    newDbName.value = ''
    await tabsStore.run(tab)
    ws.refreshTables(tab.connectionId)
  } catch (e) {
    tab.error = e instanceof Error ? e.message : String(e)
  }
}
async function dropDatabase(tab: Tab, name: string): Promise<void> {
  if (!confirm(`Drop database "${name}"? This cannot be undone.`)) return
  try {
    await window.api.db.dropDatabase(tab.connectionId, name)
    await tabsStore.run(tab)
  } catch (e) {
    tab.error = e instanceof Error ? e.message : String(e)
  }
}
function useHistoryEntry(sql: string): void {
  if (ws.activeConnectionId) tabsStore.openQueryWith(ws.activeConnectionId, sql)
}
function relTime(iso: string): string {
  const d = new Date(iso)
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return d.toLocaleDateString()
}

async function killProcess(tab: Tab, row: unknown[]): Promise<void> {
  const pid = row[0]
  if (pid == null || !confirm(`Kill process ${pid}?`)) return
  try {
    await window.api.db.killProcess(tab.connectionId, pid as string | number)
    await tabsStore.run(tab)
  } catch (e) {
    tab.error = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <main class="main">
    <header class="topbar" :class="{ inset: ui.isMac && ui.sidebarCollapsed }">
      <button class="icon-btn" title="Toggle sidebar (⌘B)" @click="ui.toggleSidebar()">☰</button>
      <template v-if="activeConn">
        <span class="dot" :style="{ background: activeConn.color || '#888f9c' }" />
        <strong class="conn-name">{{ activeConn.name }}</strong>
        <span class="meta">{{ activeConn.driver }}<template v-if="activeConn.database"> · {{ activeConn.database }}</template></span>
        <span class="state" :class="ws.connStates[activeConn.id] || 'disconnected'" />
      </template>
      <strong v-else class="brand-title">DataDock</strong>
      <div class="spacer drag" />
      <template v-if="activeConn">
        <button class="btn btn-ghost" @click="newQuery">＋ Query</button>
        <button class="btn" @click="disconnect">Disconnect</button>
      </template>
    </header>

    <div v-if="!activeConn" class="welcome">
      <div class="welcome-card">
        <img class="welcome-logo" :src="logoUrl" alt="DataDock" />
        <h1>DataDock</h1>
        <p>Select a connection from the sidebar to get started.</p>
        <p class="sub">Organize connections into projects and environment folders on the left.</p>
      </div>
    </div>

    <template v-else>
      <div v-if="ws.error" class="conn-error">{{ ws.error }}</div>

      <div class="work">
        <!-- Table list -->
        <div class="tables" v-show="!ui.tablesCollapsed">
          <div class="tables-head">
            <input class="input filter" v-model="tableFilter" placeholder="Filter tables…" />
            <button class="icon-btn sm" title="Collapse list" @click="ui.toggleTables()">‹</button>
          </div>
          <div class="table-list">
            <div
              v-for="t in filteredTables"
              :key="(t.schema || '') + t.name"
              class="table-item"
              @click="openTable(t)"
            >
              <span class="ticon">{{ t.type === 'view' ? '◫' : '▦' }}</span>
              <span class="tname">{{ t.name }}</span>
            </div>
            <div v-if="filteredTables.length === 0" class="no-tables">No tables</div>
          </div>
        </div>
        <button v-if="ui.tablesCollapsed" class="tables-expand" title="Show tables" @click="ui.toggleTables()">›</button>

        <!-- Tabs + content -->
        <div class="tab-area">
          <div class="tab-strip">
            <div
              v-for="tab in connTabs"
              :key="tab.id"
              class="tab"
              :class="{ on: active?.id === tab.id }"
              @click="tabsStore.setActive(activeConn.id, tab.id)"
            >
              <span class="tab-kind" :class="tab.kind" />
              <span class="tab-title">{{ tab.title }}</span>
              <span v-if="tab.kind === 'table' && tabsStore.dirtyCount(tab)" class="tab-dirty">●</span>
              <button class="tab-close" @click.stop="tabsStore.closeTab(tab.id)">✕</button>
            </div>
            <button class="tab-add" @click="newQuery" title="New query">＋</button>
          </div>

          <div v-if="!active" class="no-tab">
            <p>No tab open. Click a table or start a query.</p>
            <button class="btn btn-primary" @click="newQuery">New query</button>
          </div>

          <!-- Query tab -->
          <div v-else-if="active.kind === 'query'" class="editor-pane">
            <div class="toolbar">
              <button class="btn btn-primary" :disabled="active.running" @click="tabsStore.run(active)">
                {{ active.running ? 'Running…' : '▶ Run' }}
              </button>
              <span class="hint">{{ isInflux ? 'Flux' : 'SQL' }} · ⌘↵</span>
              <div class="spacer" />
              <span v-if="active.result && !active.error" class="status-mini">
                {{ active.result.rowCount }} rows · {{ Math.round(active.result.durationMs) }} ms
              </span>
              <button class="btn btn-ghost" :disabled="!active.result" @click="exportOpen = true">⤓ Export</button>
            </div>
            <div class="editor-host">
              <SqlEditor
                v-model="active.query"
                :schema="ws.schemas[active.connectionId]"
                :placeholder="isInflux ? 'from(bucket: …) |> range(start: -1h)' : 'SELECT * FROM …'"
                @run="tabsStore.run(active)"
              />
            </div>
            <div class="results">
              <div v-if="active.error" class="run-error">{{ active.error }}</div>
              <ResultsGrid v-else :result="active.result" />
            </div>
          </div>

          <!-- Table tab -->
          <div v-else-if="active.kind === 'table'" class="table-pane">
            <div class="toolbar">
              <div class="view-toggle">
                <button :class="{ on: active.viewMode === 'data' }" @click="tabsStore.setViewMode(active, 'data')">Data</button>
                <button :class="{ on: active.viewMode === 'structure' }" @click="tabsStore.setViewMode(active, 'structure')">Structure</button>
              </div>
              <span class="tb-sep" />
              <template v-if="active.viewMode === 'data'">
                <button class="btn btn-ghost" :disabled="active.offset === 0 || active.running" @click="tabsStore.prevPage(active)">‹ Prev</button>
                <span class="page">{{ pageInfo(active) }}</span>
                <button
                  class="btn btn-ghost"
                  :disabled="active.running || (active.result && active.result.rows.length < active.pageSize) || false"
                  @click="tabsStore.nextPage(active)"
                >Next ›</button>
                <select class="select sm" :value="active.pageSize" @change="tabsStore.setPageSize(active, Number(($event.target as HTMLSelectElement).value))">
                  <option :value="100">100</option>
                  <option :value="200">200</option>
                  <option :value="500">500</option>
                  <option :value="1000">1000</option>
                </select>
                <button class="btn btn-ghost" @click="tabsStore.reloadTable(active)" title="Refresh">⟳</button>
                <button
                  v-if="tabsStore.editsAllowed(active)"
                  class="btn btn-ghost"
                  @click="tabsStore.addInsertRow(active)"
                >＋ Add row</button>
                <div class="spacer" />
                <template v-if="tabsStore.dirtyCount(active) > 0">
                  <span class="dirty-info">{{ tabsStore.dirtyCount(active) }} unsaved</span>
                  <button class="btn btn-ghost" @click="tabsStore.discardEdits(active)">Discard</button>
                  <button class="btn btn-primary" :disabled="active.running" @click="tabsStore.commit(active)">Save ⌘S</button>
                </template>
                <span v-else-if="active.result" class="status-mini">{{ active.result.rowCount }} rows · {{ Math.round(active.result.durationMs) }} ms</span>
                <button class="btn btn-ghost" :disabled="!active.result" @click="exportOpen = true">⤓ Export</button>
              </template>
              <template v-else>
                <button class="btn btn-ghost" @click="tabsStore.loadStructure(active)" title="Refresh">⟳ Reload</button>
                <div class="spacer" />
                <span v-if="active.running" class="status-mini">Working…</span>
              </template>
            </div>

            <!-- Structure view -->
            <StructurePanel
              v-if="active.viewMode === 'structure'"
              :structure="active.structure"
              :tables="ws.tables.map((t) => t.name)"
              :busy="active.running"
              @alter="(op) => tabsStore.applyAlter(active!, op)"
            />

            <!-- Data view -->
            <template v-else>
            <FilterBar
              v-if="active.result"
              :columns="active.result.columns"
              :filters="active.filters"
              @apply="(f) => onApplyFilters(active!, f)"
            />

            <div class="table-body">
              <div class="grid-host">
                <div v-if="active.error" class="run-error">{{ active.error }}</div>
                <ResultsGrid
                  v-else
                  :result="active.result"
                  :editable="tabsStore.editsAllowed(active)"
                  :sortable="true"
                  :edits="active.edits"
                  :inserts="active.inserts"
                  :deletes="active.deletes"
                  :sort="active.sort"
                  :selected-row="active.selectedRow"
                  @select-row="(r) => (active!.selectedRow = r)"
                  @sort="(c) => tabsStore.toggleSort(active!, c)"
                  @edit-cell="(r, col, v) => tabsStore.editCell(active!, r, col, v)"
                  @edit-insert="(i, col, v) => tabsStore.editInsert(active!, i, col, v)"
                  @remove-insert="(i) => tabsStore.removeInsert(active!, i)"
                />
              </div>
              <RowDetailPanel
                v-if="active.selectedRow !== null && active.result"
                :columns="active.result.columns"
                :row="active.result.rows[active.selectedRow]"
                :row-index="active.selectedRow"
                :edits="active.edits[active.selectedRow]"
                :primary-keys="active.primaryKeys"
                :editable="tabsStore.editsAllowed(active)"
                :dirty-count="tabsStore.dirtyCount(active)"
                @edit-cell="(r, col, v) => tabsStore.editCell(active!, r, col, v)"
                @commit="tabsStore.commit(active!)"
                @discard="tabsStore.discardEdits(active!)"
                @close="active!.selectedRow = null"
              />
            </div>
            </template>
          </div>

          <!-- Databases tab -->
          <div v-else-if="active.kind === 'databases'" class="server-pane">
            <div class="toolbar">
              <input class="input db-input" v-model="newDbName" placeholder="New database name" @keydown.enter="createDatabase(active)" />
              <button class="btn btn-primary" :disabled="!newDbName.trim()" @click="createDatabase(active)">Create</button>
              <div class="spacer" />
              <button class="btn btn-ghost" @click="tabsStore.run(active)">⟳</button>
            </div>
            <div v-if="active.error" class="run-error">{{ active.error }}</div>
            <div class="db-list">
              <div v-for="db in active.databases" :key="db" class="db-row">
                <span class="db-icon">🗄</span>
                <span class="db-name">{{ db }}</span>
                <button class="btn-ghost drop" @click="dropDatabase(active, db)">Drop</button>
              </div>
            </div>
          </div>

          <!-- Users tab -->
          <div v-else-if="active.kind === 'users'" class="server-pane">
            <div class="toolbar">
              <strong>Users &amp; Roles</strong>
              <div class="spacer" />
              <span v-if="active.result" class="status-mini">{{ active.result.rowCount }} rows</span>
              <button class="btn btn-ghost" @click="tabsStore.run(active)">⟳</button>
            </div>
            <div class="results">
              <div v-if="active.error" class="run-error">{{ active.error }}</div>
              <ResultsGrid v-else :result="active.result" />
            </div>
          </div>

          <!-- Processes tab -->
          <div v-else-if="active.kind === 'processes'" class="server-pane">
            <div class="toolbar">
              <strong>Process list</strong>
              <div class="spacer" />
              <span v-if="active.result" class="status-mini">{{ active.result.rowCount }} active</span>
              <button class="btn btn-ghost" @click="tabsStore.run(active)">⟳</button>
            </div>
            <div class="results">
              <div v-if="active.error" class="run-error">{{ active.error }}</div>
              <ResultsGrid v-else :result="active.result" action-label="Kill" @action="(row) => killProcess(active!, row)" />
            </div>
          </div>

          <!-- Query history tab -->
          <div v-else-if="active.kind === 'history'" class="server-pane">
            <div class="toolbar">
              <strong>Query History</strong>
              <div class="spacer" />
              <span class="status-mini">{{ active.entries?.length || 0 }} entries</span>
              <button class="btn btn-ghost" @click="tabsStore.run(active)">⟳</button>
              <button class="btn btn-ghost btn-danger" @click="tabsStore.clearHistory(active)">Clear</button>
            </div>
            <div class="history-list">
              <div
                v-for="h in active.entries"
                :key="h.id"
                class="history-item"
                :class="{ failed: !!h.error }"
                @click="useHistoryEntry(h.sql)"
                title="Click to open in a new query tab"
              >
                <pre class="history-sql">{{ h.sql }}</pre>
                <div class="history-meta">
                  <span>{{ relTime(h.ranAt) }}</span>
                  <span v-if="h.error" class="err">error</span>
                  <span v-else-if="h.rowCount !== undefined">{{ h.rowCount }} rows · {{ Math.round(h.durationMs || 0) }} ms</span>
                </div>
              </div>
              <div v-if="!active.entries || active.entries.length === 0" class="no-tables">No queries yet.</div>
            </div>
          </div>
        </div>
      </div>

      <ExportModal
        v-if="exportOpen && active && active.result"
        :conn-id="activeConn.id"
        :columns="active.result.columns"
        :rows="active.result.rows"
        :table-name="active.kind === 'table' ? active.table?.name : 'query_result'"
        :table="active.kind === 'table' ? active.table : undefined"
        @close="exportOpen = false"
      />
      <ExportDbModal
        v-if="ui.exportDbOpen"
        :conn-id="activeConn.id"
        :tables="ws.tables"
        @close="ui.exportDbOpen = false"
      />
      <ImportModal
        v-if="ui.importOpen"
        :conn-id="activeConn.id"
        :tables="ws.tables"
        @close="ui.importOpen = false"
        @done="ws.refreshTables(activeConn.id)"
      />
    </template>
  </main>
</template>

<style scoped>
.main {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
  overflow: hidden;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 44px;
  flex-shrink: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}
.topbar.inset {
  padding-left: 78px; /* clear macOS traffic lights when sidebar is collapsed */
}
.topbar .icon-btn,
.topbar .btn {
  -webkit-app-region: no-drag;
}
.icon-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
}
.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.icon-btn.sm {
  width: 22px;
  height: 22px;
  font-size: 13px;
}
.brand-title {
  font-weight: 700;
  letter-spacing: 0.01em;
}
.conn-name {
  font-weight: 600;
}
.meta {
  color: var(--text-faint);
  font-size: 12px;
}
.spacer.drag {
  -webkit-app-region: drag;
}
.welcome {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.welcome-card {
  text-align: center;
  color: var(--text-dim);
}
.welcome-logo {
  width: 84px;
  height: 84px;
  margin-bottom: 18px;
  filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.35));
}
.welcome-card h1 {
  font-size: 30px;
  letter-spacing: -0.5px;
  color: var(--text);
  margin-bottom: 8px;
}
.welcome-card .sub {
  font-size: 12px;
  color: var(--text-faint);
  margin-top: 6px;
}
.topbar .btn {
  padding: 5px 11px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.state {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}
.state.connected {
  background: var(--ok);
  box-shadow: 0 0 6px var(--ok);
}
.state.connecting {
  background: var(--warn);
}
.state.error {
  background: var(--danger);
}
.spacer {
  flex: 1;
}
.conn-error {
  background: rgba(229, 97, 106, 0.13);
  color: var(--danger);
  padding: 7px 14px;
  font-size: 12px;
  font-family: var(--mono);
}
.work {
  flex: 1;
  display: flex;
  overflow: hidden;
}
.tables {
  width: 210px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  overflow: hidden;
}
.tables-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 9px 8px;
  flex-shrink: 0;
}
.filter {
  flex: 1;
  min-width: 0;
}
.tables-expand {
  width: 18px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-sidebar);
  color: var(--text-faint);
}
.tables-expand:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.table-list {
  overflow-y: auto;
  padding: 0 6px 12px;
}
.table-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.table-item:hover {
  background: var(--bg-hover);
}
.ticon {
  color: var(--accent);
  font-size: 12px;
}
.tname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.no-tables {
  color: var(--text-faint);
  padding: 10px;
  font-size: 12px;
}

/* Tabs */
.tab-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tab-strip {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 6px 6px 0;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  background: var(--bg-app);
}
.tab {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-bottom: none;
  color: var(--text-dim);
  white-space: nowrap;
  max-width: 220px;
  cursor: pointer;
}
.tab.on {
  background: var(--bg-elevated);
  color: var(--text);
}
.tab-kind {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--text-faint);
}
.tab-kind.table {
  background: var(--accent);
}
.tab-kind.query {
  background: #5b8def;
}
.tab-kind.databases {
  background: #e0a14a;
}
.tab-kind.users {
  background: #9b7ede;
}
.tab-kind.processes {
  background: var(--danger);
}
.tab-kind.history {
  background: #888f9c;
}
.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab-dirty {
  color: var(--warn);
  font-size: 9px;
}
.tab-close {
  color: var(--text-faint);
  font-size: 10px;
  width: 16px;
  height: 16px;
  border-radius: 3px;
}
.tab-close:hover {
  background: var(--bg-active);
  color: var(--text);
}
.tab-add {
  padding: 0 10px;
  color: var(--text-dim);
}
.tab-add:hover {
  color: var(--text);
}
.no-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--text-dim);
}

.editor-pane {
  flex: 1;
  display: grid;
  grid-template-rows: auto minmax(110px, 0.4fr) 1fr;
  overflow: hidden;
}
.table-pane {
  flex: 1;
  display: grid;
  grid-template-rows: auto auto 1fr;
  overflow: hidden;
}
.table-body {
  display: flex;
  overflow: hidden;
}
.grid-host {
  flex: 1;
  overflow: hidden;
}
.server-pane {
  flex: 1;
  display: grid;
  grid-template-rows: auto 1fr;
  overflow: hidden;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.toolbar .hint {
  color: var(--text-faint);
  font-size: 11px;
}
.toolbar .btn {
  padding: 4px 10px;
}
.view-toggle {
  display: flex;
  gap: 2px;
  -webkit-app-region: no-drag;
}
.view-toggle button {
  padding: 4px 12px;
  font-size: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
}
.view-toggle button:first-child {
  border-radius: var(--radius-sm) 0 0 var(--radius-sm);
}
.view-toggle button:last-child {
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  border-left: none;
}
.view-toggle button.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.tb-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 2px;
}
.page {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
  min-width: 70px;
  text-align: center;
}
.select.sm {
  padding: 4px 6px;
  font-size: 12px;
}
.db-input {
  width: 240px;
}
.status-mini {
  color: var(--text-dim);
  font-size: 11px;
  font-family: var(--mono);
}
.dirty-info {
  color: var(--warn);
  font-size: 12px;
}
.editor-host {
  overflow: hidden;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.results {
  overflow: hidden;
}
.run-error {
  padding: 14px;
  color: var(--danger);
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  overflow: auto;
  height: 100%;
}
.db-list {
  overflow-y: auto;
  padding: 8px;
}
.history-list {
  overflow-y: auto;
  padding: 8px 10px;
}
.history-item {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 7px;
  cursor: pointer;
}
.history-item:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}
.history-item.failed {
  border-left: 2px solid var(--danger);
}
.history-sql {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 60px;
  overflow: hidden;
  margin: 0;
}
.history-meta {
  display: flex;
  gap: 12px;
  margin-top: 5px;
  font-size: 11px;
  color: var(--text-faint);
}
.history-meta .err {
  color: var(--danger);
}
.btn-danger {
  color: var(--danger);
}
.db-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
}
.db-row:hover {
  background: var(--bg-hover);
}
.db-name {
  flex: 1;
  font-family: var(--mono);
}
.drop {
  color: var(--danger);
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 4px;
}
.drop:hover {
  background: rgba(229, 97, 106, 0.15);
}
</style>
