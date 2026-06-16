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
import NamePrompt from './NamePrompt.vue'
import CreateTableModal from './CreateTableModal.vue'
import DropTablesModal from './DropTablesModal.vue'
import ContextMenu from './ContextMenu.vue'
import ErDiagram from './ErDiagram.vue'
import SchemaDiffPanel from './SchemaDiffPanel.vue'
import DataDiffPanel from './DataDiffPanel.vue'
import DataGeneratorModal from './DataGeneratorModal.vue'
import AiAssistantModal from './AiAssistantModal.vue'
import QueryVarsModal from './QueryVarsModal.vue'
import PlanTreeModal from './PlanTreeModal.vue'
import BulkEditModal from './BulkEditModal.vue'
import DependenciesModal from './DependenciesModal.vue'
import TableSizesModal from './TableSizesModal.vue'
import ColumnSearchModal from './ColumnSearchModal.vue'
import type { DropTableOptions, PlanNode } from '@shared/types'

type MenuItem = { label?: string; danger?: boolean; sep?: boolean; action?: () => void }
import { type FilterSpec, type Snippet, type TableInfo } from '@shared/types'
import { formatSql } from '../lib/sql'
import { rowToJson, rowToCsv, rowToInsert, rowsToInserts, rowsToUpdates } from '../lib/rowCopy'
import { canExportToTable, planResultTable } from '../lib/resultTable'
import logoUrl from '../assets/logo.png'

const ws = useWorkspace()
const tabsStore = useTabs()
const ui = useUi()

const tableFilter = ref('')
const newDbName = ref('')

const exportOpen = ref(false)
const saveSnippetOpen = ref(false)
const createTableOpen = ref(false)
const exportTableTarget = ref<TableInfo | null>(null)
const genTarget = ref<TableInfo | null>(null)
const aiOpen = ref(false)
const aiMode = ref<'generate' | 'explain' | 'fix'>('generate')

// Query variables: `{{name}}` placeholders are collected and substituted before
// the query runs, without altering the saved template.
const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g
const queryVars = ref<{ names: string[]; tab: Tab } | null>(null)

function runActive(tab: Tab): void {
  if (tab.kind === 'query') {
    const names = [...new Set([...tab.query.matchAll(VAR_RE)].map((m) => m[1]))]
    if (names.length) {
      queryVars.value = { names, tab }
      return
    }
  }
  void tabsStore.run(tab)
}
function runWithVars(values: Record<string, string>): void {
  const pending = queryVars.value
  queryVars.value = null
  if (!pending) return
  const sql = pending.tab.query.replace(VAR_RE, (_m, name: string) => values[name] ?? '')
  void tabsStore.run(pending.tab, sql)
}

function openAi(mode: 'generate' | 'explain' | 'fix'): void {
  aiMode.value = mode
  aiOpen.value = true
}

// Visual EXPLAIN — fetch the structured plan and show it as an interactive tree.
const planRoot = ref<PlanNode | null>(null)
const planLoading = ref(false)
async function openPlan(tab: Tab): Promise<void> {
  if (tab.kind !== 'query' || !tab.query.trim() || planLoading.value) return
  planLoading.value = true
  try {
    const root = await window.api.db.explainPlan(tab.connectionId, tab.query)
    if (root) {
      planRoot.value = root
    } else {
      // Engine has no structured plan — fall back to the flat textual EXPLAIN.
      void tabsStore.explain(tab)
    }
  } catch (err) {
    tab.error = err instanceof Error ? err.message : String(err)
  } finally {
    planLoading.value = false
  }
}

// Export the current result set into a brand-new table (SQL engines only).
const toTableOpen = ref(false)
const toTableBusy = ref(false)
const canResultToTable = computed(() => {
  const a = active.value
  return (
    !!a?.result &&
    a.result.columns.length > 0 &&
    !!activeConn.value &&
    !readOnly.value &&
    canExportToTable(activeConn.value.driver)
  )
})
async function exportResultToTable(name: string): Promise<void> {
  const a = active.value
  const conn = activeConn.value
  if (!a?.result || !conn || !canExportToTable(conn.driver)) return
  toTableBusy.value = true
  try {
    const { spec, inserts } = planResultTable(name, a.result.columns, a.result.rows, conn.driver)
    await window.api.db.createTable(conn.id, spec)
    if (inserts.length) {
      await window.api.db.applyChanges(conn.id, { name: spec.name, type: 'table' }, {
        updates: [],
        inserts,
        deletes: []
      })
    }
    toTableOpen.value = false
    await ws.refreshTables(conn.id)
    tabsStore.openTable(conn.id, { name: spec.name, type: 'table' })
  } catch (e) {
    a.error = e instanceof Error ? e.message : String(e)
    toTableOpen.value = false
  } finally {
    toTableBusy.value = false
  }
}

// Bulk edit — set one column across the ticked rows, staged as pending edits.
const bulkOpen = ref(false)
function applyBulkEdit(column: string, value: unknown): void {
  const a = active.value
  if (!a) return
  tabsStore.bulkEdit(a, [...a.selection], column, value)
  tabsStore.clearSelection(a)
  bulkOpen.value = false
}

// Generate INSERT / UPDATE statements from the ticked rows into a new query tab.
function openGenerateSqlMenu(e: MouseEvent): void {
  const a = active.value
  if (!a?.result || a.kind !== 'table' || !a.table) return
  const cols = a.result.columns
  const rows = [...a.selection].sort((x, y) => x - y).map((i) => a.result!.rows[i] as unknown[])
  const table = a.table.name
  ctx.value = {
    x: e.clientX,
    y: e.clientY,
    items: [
      {
        label: `Generate ${rows.length} INSERT${rows.length === 1 ? '' : 's'}`,
        action: () => {
          tabsStore.openQueryWith(a.connectionId, rowsToInserts(table, cols, rows), `INSERT ${table}`)
          tabsStore.clearSelection(a)
        }
      },
      {
        label: `Generate ${rows.length} UPDATE${rows.length === 1 ? '' : 's'}`,
        action: () => {
          tabsStore.openQueryWith(
            a.connectionId,
            rowsToUpdates(table, cols, rows, a.primaryKeys),
            `UPDATE ${table}`
          )
          tabsStore.clearSelection(a)
        }
      }
    ]
  }
}

// Right-click a result row → copy it as JSON / CSV / SQL INSERT.
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard unavailable */
  }
}
function onRowContext(tab: Tab, rowIndex: number, e: MouseEvent): void {
  const result = tab.result
  if (!result || !result.columns.length) return
  const row = result.rows[rowIndex] as unknown[]
  if (!row) return
  const table = tab.kind === 'table' && tab.table ? tab.table.name : 'table'
  const items: MenuItem[] = []
  if (tabsStore.editsAllowed(tab)) {
    items.push(
      { label: 'Duplicate row', action: () => tabsStore.duplicateRow(tab, rowIndex) },
      { sep: true }
    )
  }
  items.push(
    { label: 'Copy row as JSON', action: () => copyText(rowToJson(result.columns, row)) },
    { label: 'Copy row as CSV', action: () => copyText(rowToCsv(result.columns, row)) },
    { label: 'Copy row as SQL INSERT', action: () => copyText(rowToInsert(table, result.columns, row)) }
  )
  ctx.value = { x: e.clientX, y: e.clientY, items }
}

// Drop AI-generated SQL into the active query tab (replacing a blank scratch
// buffer, or appending below existing text so nothing is clobbered).
function applyAiSql(sql: string): void {
  const tab = active.value
  if (!tab || tab.kind !== 'query') return
  tab.query = tab.query.trim() ? `${tab.query.trim()}\n\n${sql}` : sql
  aiOpen.value = false
}

function onGenerated(): void {
  const name = genTarget.value?.name
  const id = activeConn.value?.id
  if (!name || !id) return
  for (const tab of tabsStore.forConnection(id)) {
    if (tab.kind === 'table' && tab.table?.name === name) void tabsStore.reloadTable(tab)
  }
}

// ---- tables-list selection (click / shift-range / cmd-toggle) --------------
const selectedTables = ref<string[]>([])
let selAnchor = -1
const tableKey = (t: TableInfo): string => `${t.schema ?? ''}.${t.name}`
const isSelected = (t: TableInfo): boolean => selectedTables.value.includes(tableKey(t))
const multiSelect = computed(() => selectedTables.value.length > 1)

function onTableClick(t: TableInfo, idx: number, e: MouseEvent): void {
  const key = tableKey(t)
  if (e.shiftKey && selAnchor >= 0) {
    const [a, b] = [selAnchor, idx].sort((x, y) => x - y)
    selectedTables.value = filteredTables.value.slice(a, b + 1).map(tableKey)
  } else if (e.metaKey || e.ctrlKey) {
    selectedTables.value = isSelected(t)
      ? selectedTables.value.filter((k) => k !== key)
      : [...selectedTables.value, key]
    selAnchor = idx
  } else {
    selectedTables.value = [key]
    selAnchor = idx
    openTable(t)
  }
}

// ---- right-click context menu ----------------------------------------------
const ctx = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

function onTableContext(t: TableInfo, idx: number, e: MouseEvent): void {
  if (!isSelected(t)) {
    selectedTables.value = [tableKey(t)]
    selAnchor = idx
  }
  const id = activeConn.value!.id
  const items: MenuItem[] = [
    { label: 'Open', action: () => openTable(t) },
    { label: 'Edit structure', action: () => tabsStore.setViewMode(tabsStore.openTable(id, t), 'structure') },
    { label: 'Export table…', action: () => (exportTableTarget.value = { schema: t.schema, name: t.name, type: t.type }) }
  ]
  if (!nonSql.value) {
    items.push({ label: 'Dependencies…', action: () => (depsTarget.value = t.name) })
  }
  if (!nonSql.value && !readOnly.value) {
    items.push({
      label: 'Generate data…',
      action: () => (genTarget.value = { schema: t.schema, name: t.name, type: t.type })
    })
    items.push(
      { sep: true },
      {
        label: multiSelect.value ? `Delete ${selectedTables.value.length} tables…` : 'Delete table…',
        danger: true,
        action: openDropModal
      }
    )
  }
  ctx.value = { x: e.clientX, y: e.clientY, items }
}

// ---- dependency explorer ---------------------------------------------------
const depsTarget = ref<string | null>(null)
function openRelatedTable(name: string): void {
  const conn = activeConn.value
  if (!conn) return
  const known = ws.tables.find((t) => t.name === name)
  tabsStore.openTable(conn.id, known ?? { name, type: 'table' })
  depsTarget.value = null
}

// ---- drop modal ------------------------------------------------------------
const dropTargets = ref<TableInfo[] | null>(null)
function openDropModal(): void {
  const sel = ws.tables.filter((t) => selectedTables.value.includes(tableKey(t)))
  if (sel.length) dropTargets.value = sel.map((t) => ({ schema: t.schema, name: t.name, type: t.type }))
}
async function performDrop(opts: DropTableOptions): Promise<void> {
  const conn = activeConn.value
  const targets = dropTargets.value
  dropTargets.value = null
  if (!conn || !targets) return
  try {
    await window.api.db.dropTables(conn.id, targets, opts)
    const dropped = new Set(targets.map((t) => t.name))
    for (const tab of tabsStore.forConnection(conn.id)) {
      if (tab.kind === 'table' && tab.table && dropped.has(tab.table.name)) tabsStore.closeTab(tab.id)
    }
    selectedTables.value = []
    await ws.refreshTables(conn.id)
  } catch (e) {
    ws.error = e instanceof Error ? e.message : String(e)
  }
}

watch(
  () => ws.activeConnectionId,
  () => {
    selectedTables.value = []
    selAnchor = -1
  }
)

// Snippet matching the active query tab's SQL (for the filled-star indicator).
const activeSaved = computed(() =>
  active.value?.kind === 'query' ? tabsStore.matchingSnippet(active.value.query) : undefined
)

function openSaveSnippet(): void {
  if (active.value?.kind === 'query' && active.value.query.trim()) saveSnippetOpen.value = true
}
async function submitSaveSnippet(name: string): Promise<void> {
  const a = active.value
  saveSnippetOpen.value = false
  if (a?.kind === 'query') {
    await tabsStore.saveSnippet(name, a.query)
    a.title = name // rename the tab to the saved query name (CSS truncates)
  }
}
function useSnippet(s: Snippet): void {
  if (ws.activeConnectionId) tabsStore.openQueryWith(ws.activeConnectionId, s.sql, s.name)
}
function formatActive(): void {
  const a = active.value
  if (a?.kind === 'query' && a.query.trim() && activeConn.value) {
    a.query = formatSql(a.query, activeConn.value.driver)
  }
}

const activeConn = computed(() =>
  ws.activeConnectionId ? ws.findConnection(ws.activeConnectionId) : undefined
)
const isInflux = computed(() => activeConn.value?.driver === 'influxdb')
const isMongo = computed(() => activeConn.value?.driver === 'mongodb')
// Engines that don't speak SQL — gate SQL-only affordances (Format, AI, the
// structure editor, EXPLAIN) off these.
const nonSql = computed(() => isInflux.value || isMongo.value)
const readOnly = computed(() => !!activeConn.value?.readOnly)
const isProduction = computed(() => !!activeConn.value?.production)
const explainable = computed(() =>
  ['postgres', 'mysql', 'sqlite'].includes(activeConn.value?.driver ?? '')
)
// Visual EXPLAIN — only engines that expose a structured plan.
const visualExplainable = computed(() =>
  ['postgres', 'sqlite'].includes(activeConn.value?.driver ?? '')
)

// Other connections (for schema diff target picker), labeled project / env / name.
const otherConnections = computed(() => {
  const out: { id: string; label: string }[] = []
  for (const p of ws.projects) {
    for (const e of p.environments) {
      for (const c of e.connections) {
        if (c.id !== ws.activeConnectionId) out.push({ id: c.id, label: `${p.name} / ${e.name} / ${c.name}` })
      }
    }
  }
  return out
})

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

  // Format SQL (⌘⇧F) in the active query tab.
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
    if (a?.kind === 'query') {
      e.preventDefault()
      formatActive()
    }
    return
  }

  // Undo / redo of draft row edits — but let inputs and the SQL editor handle their own.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    if (inEditableField()) return
    if (!a || a.kind !== 'table') return
    e.preventDefault()
    if (e.shiftKey) tabsStore.redo(a)
    else tabsStore.undo(a)
    return
  }

  // Backspace / Delete: mark a selected data row for deletion, OR drop tables
  // selected in the list (unless typing in a field).
  if (e.key !== 'Backspace' && e.key !== 'Delete') return
  if (inEditableField()) return
  if (a && a.kind === 'table' && a.viewMode === 'data' && a.selectedRow !== null && tabsStore.editsAllowed(a)) {
    e.preventDefault()
    tabsStore.toggleDelete(a, a.selectedRow)
    return
  }
  if (selectedTables.value.length && !nonSql.value && !readOnly.value) {
    e.preventDefault()
    openDropModal()
  }
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
        <span v-if="readOnly" class="ro-badge" title="Read-only (safe mode)">🔒 Read-only</span>
      </template>
      <strong v-else class="brand-title">DataDock</strong>
      <div class="spacer drag" />
      <button class="icon-btn palette-btn" title="Command palette (⌘K)" @click="ui.openPalette()">⌘K</button>
      <button class="icon-btn" :title="ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'" @click="ui.toggleTheme()">
        {{ ui.theme === 'dark' ? '☀' : '☾' }}
      </button>
      <template v-if="activeConn">
        <template v-if="!nonSql && !readOnly">
          <template v-if="ws.txn[activeConn.id]">
            <span class="txn-badge" title="Open transaction — uncommitted">● TX</span>
            <button class="btn btn-ghost txn-commit" @click="ws.commitTxn(activeConn.id)">Commit</button>
            <button class="btn btn-ghost txn-rollback" @click="ws.rollbackTxn(activeConn.id)">Rollback</button>
          </template>
          <button v-else class="btn btn-ghost" title="Begin transaction" @click="ws.beginTxn(activeConn.id)">⇄ Begin Tx</button>
        </template>
        <button class="btn btn-ghost" @click="newQuery">＋ Query</button>
        <button class="btn" @click="disconnect">Disconnect</button>
      </template>
    </header>

    <div v-if="!activeConn" class="welcome">
      <div class="welcome-card">
        <div class="welcome-icon">
          <img class="welcome-logo" :src="logoUrl" alt="DataDock" />
        </div>
        <h1>DataDock</h1>
        <p>Select a connection from the sidebar to get started.</p>
        <p class="sub">Organize connections into projects and environment folders on the left.</p>
      </div>
    </div>

    <template v-else>
      <div v-if="isProduction" class="prod-banner">
        ⚠ PRODUCTION — {{ activeConn.name }}. Changes here affect live data.
      </div>
      <div v-if="ws.error" class="conn-error">{{ ws.error }}</div>

      <div class="work">
        <!-- Table list -->
        <div class="tables" v-show="!ui.tablesCollapsed">
          <div class="tables-head">
            <input class="input filter" v-model="tableFilter" placeholder="Filter tables…" />
            <button v-if="!nonSql && !readOnly" class="icon-btn sm" title="New table" @click="createTableOpen = true">＋</button>
            <button class="icon-btn sm" title="Collapse list" @click="ui.toggleTables()">‹</button>
          </div>
          <div class="table-list">
            <div
              v-for="(t, idx) in filteredTables"
              :key="(t.schema || '') + t.name"
              class="table-item"
              :class="{ selected: isSelected(t) }"
              @click="onTableClick(t, idx, $event)"
              @contextmenu.prevent="onTableContext(t, idx, $event)"
            >
              <span class="ticon">{{ t.type === 'view' ? '◫' : '▦' }}</span>
              <span class="tname">{{ t.name }}</span>
            </div>
            <div v-if="filteredTables.length === 0" class="no-tables">No tables</div>
          </div>
          <div v-if="multiSelect" class="sel-hint">{{ selectedTables.length }} selected · ⌫ to delete</div>
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
              <button class="btn btn-primary" :disabled="active.running" @click="runActive(active)">
                {{ active.running ? 'Running…' : '▶ Run' }}
              </button>
              <span class="hint">{{ isMongo ? 'MongoDB' : isInflux ? 'Flux' : 'SQL' }} · ⌘↵</span>
              <button v-if="explainable" class="btn btn-ghost" :disabled="!active.query.trim() || active.running" title="Show query plan (EXPLAIN)" @click="tabsStore.explain(active)">◔ Explain</button>
              <button v-if="visualExplainable" class="btn btn-ghost" :disabled="!active.query.trim() || active.running || planLoading" title="Visualize the query plan as a tree" @click="openPlan(active)">◧ {{ planLoading ? 'Plan…' : 'Plan' }}</button>
              <button v-if="!nonSql" class="btn btn-ghost" :disabled="!active.query.trim()" title="Format SQL (⌘⇧F)" @click="formatActive">⧉ Format</button>
              <button v-if="!nonSql" class="btn btn-ghost ai-btn" title="Generate SQL with AI" @click="openAi('generate')">✨ AI</button>
              <div class="spacer" />
              <span v-if="active.result && !active.error" class="status-mini">
                {{ active.result.rowCount }} rows · {{ Math.round(active.result.durationMs) }} ms
              </span>
              <button
                class="btn btn-ghost"
                :class="{ 'is-saved': activeSaved }"
                :disabled="!active.query.trim()"
                @click="openSaveSnippet"
                :title="activeSaved ? `Saved as “${activeSaved.name}”` : 'Save as snippet'"
              >{{ activeSaved ? '★ Saved' : '☆ Save' }}</button>
              <button v-if="canResultToTable" class="btn btn-ghost" title="Save this result as a new table" @click="toTableOpen = true">⤒ To table</button>
              <button class="btn btn-ghost" :disabled="!active.result" @click="exportOpen = true">⤓ Export</button>
            </div>
            <div class="editor-host">
              <SqlEditor
                v-model="active.query"
                :schema="ws.schemas[active.connectionId]"
                :placeholder="isMongo ? 'db.collection.find({ })' : isInflux ? 'from(bucket: …) |> range(start: -1h)' : 'SELECT * FROM …'"
                @run="runActive(active)"
              />
            </div>
            <div class="results">
              <div v-if="active.error" class="run-error">
                <div class="run-error-head">
                  <span class="run-error-msg">{{ active.error }}</span>
                  <button v-if="!nonSql" class="btn btn-ghost ai-btn fix-btn" title="Ask AI to fix this query" @click="openAi('fix')">✨ Fix with AI</button>
                </div>
              </div>
              <ResultsGrid v-else :result="active.result" @row-context="(r, e) => onRowContext(active!, r, e)" />
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
                <button
                  v-if="tabsStore.editsAllowed(active) && active.selection.length > 0"
                  class="btn btn-ghost"
                  title="Set a column to one value across the selected rows"
                  @click="bulkOpen = true"
                >✐ Bulk edit ({{ active.selection.length }})</button>
                <button
                  v-if="tabsStore.editsAllowed(active) && active.selection.length > 0"
                  class="btn btn-ghost"
                  title="Generate INSERT/UPDATE SQL from the selected rows"
                  @click="openGenerateSqlMenu"
                >⌖ Generate SQL</button>
                <div class="spacer" />
                <template v-if="tabsStore.dirtyCount(active) > 0">
                  <span class="dirty-info">{{ tabsStore.dirtyCount(active) }} unsaved</span>
                  <button class="btn btn-ghost" @click="tabsStore.discardEdits(active)">Discard</button>
                  <button class="btn btn-primary" :disabled="active.running" @click="tabsStore.commit(active)">Save ⌘S</button>
                </template>
                <span v-else-if="active.result" class="status-mini">{{ active.result.rowCount }} rows · {{ Math.round(active.result.durationMs) }} ms</span>
                <button v-if="canResultToTable" class="btn btn-ghost" title="Save this result as a new table" @click="toTableOpen = true">⤒ To table</button>
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
              :read-only="readOnly"
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
                  :selectable="tabsStore.editsAllowed(active)"
                  :selected-rows="active.selection"
                  @select-row="(r) => (active!.selectedRow = r)"
                  @toggle-select="(r) => tabsStore.toggleRowSelection(active!, r)"
                  @toggle-select-all="tabsStore.toggleSelectAll(active!)"
                  @sort="(c) => tabsStore.toggleSort(active!, c)"
                  @edit-cell="(r, col, v) => tabsStore.editCell(active!, r, col, v)"
                  @edit-insert="(i, col, v) => tabsStore.editInsert(active!, i, col, v)"
                  @remove-insert="(i) => tabsStore.removeInsert(active!, i)"
                  @row-context="(r, e) => onRowContext(active!, r, e)"
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

          <!-- Saved queries / snippets tab -->
          <div v-else-if="active.kind === 'snippets'" class="server-pane">
            <div class="toolbar">
              <strong>Saved Queries</strong>
              <div class="spacer" />
              <span class="status-mini">{{ active.snippets?.length || 0 }} saved</span>
              <button class="btn btn-ghost" @click="tabsStore.run(active)">⟳</button>
            </div>
            <div class="history-list">
              <div
                v-for="s in active.snippets"
                :key="s.id"
                class="history-item snippet"
                @click="useSnippet(s)"
                title="Click to open in a new query tab"
              >
                <div class="snippet-head">
                  <span class="snippet-name">{{ s.name }}</span>
                  <button class="btn-ghost drop" @click.stop="tabsStore.deleteSnippet(active!, s.id)">✕</button>
                </div>
                <pre class="history-sql">{{ s.sql }}</pre>
              </div>
              <div v-if="!active.snippets || active.snippets.length === 0" class="no-tables">
                No saved queries yet. Write a query and press ☆ Save.
              </div>
            </div>
          </div>

          <!-- ER diagram tab -->
          <div v-else-if="active.kind === 'diagram'" class="server-pane">
            <ErDiagram
              :model="active.erModel ?? null"
              :running="active.running"
              @reload="tabsStore.run(active!)"
            />
          </div>

          <!-- Schema diff tab -->
          <div v-else-if="active.kind === 'schemaDiff'" class="server-pane">
            <SchemaDiffPanel
              :conn-id="activeConn.id"
              :conn-name="activeConn.name"
              :candidates="otherConnections"
            />
          </div>

          <!-- Data diff tab -->
          <div v-else-if="active.kind === 'dataDiff'" class="server-pane">
            <DataDiffPanel
              :conn-id="activeConn.id"
              :conn-name="activeConn.name"
              :candidates="otherConnections"
              :tables="ws.tables"
            />
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
      <NamePrompt
        v-if="saveSnippetOpen"
        title="Save query as…"
        submit-label="Save"
        @submit="submitSaveSnippet"
        @close="saveSnippetOpen = false"
      />
      <NamePrompt
        v-if="toTableOpen"
        title="Save result as new table"
        :initial="active && active.kind === 'table' ? `${active.table?.name}_copy` : 'query_result'"
        :submit-label="toTableBusy ? 'Creating…' : 'Create table'"
        @submit="exportResultToTable"
        @close="toTableOpen = false"
      />
      <CreateTableModal
        v-if="createTableOpen"
        :conn-id="activeConn.id"
        :driver="activeConn.driver"
        @created="ws.refreshTables(activeConn.id)"
        @close="createTableOpen = false"
      />
      <DropTablesModal
        v-if="dropTargets"
        :tables="dropTargets"
        :driver="activeConn.driver"
        @confirm="performDrop"
        @close="dropTargets = null"
      />
      <ExportModal
        v-if="exportTableTarget"
        :conn-id="activeConn.id"
        :table="exportTableTarget"
        :table-name="exportTableTarget.name"
        @close="exportTableTarget = null"
      />
      <DataGeneratorModal
        v-if="genTarget"
        :conn-id="activeConn.id"
        :driver="activeConn.driver"
        :table="genTarget"
        @done="onGenerated"
        @close="genTarget = null"
      />
      <ContextMenu v-if="ctx" :x="ctx.x" :y="ctx.y" :items="ctx.items" @close="ctx = null" />

      <AiAssistantModal
        v-if="aiOpen"
        :driver="activeConn.driver"
        :schema="ws.schemas[activeConn.id] || {}"
        :sql="active && active.kind === 'query' ? active.query : ''"
        :error="active && active.kind === 'query' ? active.error || '' : ''"
        :initial-mode="aiMode"
        @insert="applyAiSql"
        @close="aiOpen = false"
      />

      <QueryVarsModal
        v-if="queryVars"
        :names="queryVars.names"
        @submit="runWithVars"
        @close="queryVars = null"
      />

      <PlanTreeModal v-if="planRoot" :root="planRoot" @close="planRoot = null" />

      <BulkEditModal
        v-if="bulkOpen && active && active.kind === 'table' && active.result"
        :columns="active.result.columns"
        :row-count="active.selection.length"
        @apply="applyBulkEdit"
        @close="bulkOpen = false"
      />

      <DependenciesModal
        v-if="depsTarget && activeConn"
        :conn-id="activeConn.id"
        :table="depsTarget"
        @open="openRelatedTable"
        @close="depsTarget = null"
      />

      <TableSizesModal
        v-if="ui.tableSizesOpen && activeConn"
        :conn-id="activeConn.id"
        @open="(n) => { openRelatedTable(n); ui.tableSizesOpen = false }"
        @close="ui.tableSizesOpen = false"
      />

      <ColumnSearchModal
        v-if="ui.columnSearchOpen && activeConn"
        :conn-id="activeConn.id"
        @open="(n) => { openRelatedTable(n); ui.columnSearchOpen = false }"
        @close="ui.columnSearchOpen = false"
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
.palette-btn {
  font-size: 11px;
  font-weight: 600;
  width: auto;
  padding: 0 8px;
  font-family: var(--mono);
  letter-spacing: 0.02em;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.palette-btn:hover {
  color: var(--text);
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
.brand-title {
  font-weight: 700;
  letter-spacing: 0.01em;
}
.conn-name {
  font-weight: 600;
}
.meta {
  color: var(--text-dim);
  font-size: 11px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  padding: 2px 9px;
  border-radius: 999px;
}
.ro-badge {
  font-size: 10px;
  font-weight: 700;
  color: var(--warn);
  background: rgba(240, 180, 41, 0.15);
  border: 1px solid rgba(240, 180, 41, 0.4);
  padding: 1px 7px;
  border-radius: 999px;
  -webkit-app-region: no-drag;
}
.txn-badge {
  font-size: 10px;
  font-weight: 700;
  color: var(--warn);
  -webkit-app-region: no-drag;
}
.txn-commit {
  color: var(--ok);
}
.txn-rollback {
  color: var(--danger);
}
.spacer.drag {
  -webkit-app-region: drag;
}
.welcome {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(ellipse 55% 45% at 50% 42%, rgba(45, 212, 191, 0.07), transparent 70%),
    radial-gradient(ellipse 85% 70% at 50% 50%, rgba(44, 70, 119, 0.16), transparent 72%);
}
.welcome-card {
  text-align: center;
  color: var(--text-dim);
  z-index: 1;
  animation: welcome-rise 0.5s ease both;
}
@keyframes welcome-rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
}
.welcome-icon {
  width: 110px;
  height: 110px;
  margin: 0 auto 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.welcome-icon::before {
  content: '';
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(45, 212, 191, 0.28), rgba(44, 70, 119, 0.12) 55%, transparent 70%);
  filter: blur(10px);
}
.welcome-logo {
  width: 92px;
  height: 92px;
  position: relative;
  filter: drop-shadow(0 16px 40px rgba(45, 212, 191, 0.22)) drop-shadow(0 8px 22px rgba(0, 0, 0, 0.55));
}
.welcome-card h1 {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.4px;
  color: var(--text);
  margin-bottom: 10px;
}
.welcome-card p {
  font-size: 13px;
}
.welcome-card .sub {
  font-size: 12px;
  color: var(--text-faint);
  margin-top: 6px;
  max-width: 340px;
  margin-left: auto;
  margin-right: auto;
}
.topbar .btn {
  padding: 5px 14px;
  border-radius: 999px;
}
.topbar .state.connected {
  box-shadow: 0 0 8px var(--accent);
  background: var(--accent);
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
.prod-banner {
  flex-shrink: 0;
  background: var(--danger);
  color: #fff;
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.03em;
  text-align: center;
  padding: 5px 12px;
}
.conn-error {
  background: rgba(248, 113, 113, 0.13);
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
.table-item.selected {
  background: var(--accent-soft);
}
.table-item.selected .tname {
  color: var(--accent);
}
.sel-hint {
  flex-shrink: 0;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 11px;
  color: var(--text-dim);
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
  padding: 7px 13px;
  border-radius: 12px 12px 0 0;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  color: var(--text-dim);
  white-space: nowrap;
  max-width: 220px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.tab:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.tab.on {
  background: var(--bg-panel);
  color: var(--text);
  border-color: var(--border);
  border-top: 2px solid var(--accent);
  padding-top: 6px;
}
.tab-kind {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}
.tab-kind.table {
  background: var(--accent);
}
.tab-kind.query {
  background: #5b8def;
}
.tab-kind.schemaDiff {
  background: #e0a14a;
}
.tab-kind.dataDiff {
  background: #e0a14a;
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
.tab-kind.snippets {
  background: #3fcf8e;
}
.tab-kind.diagram {
  background: #f59e0b;
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
/* Data view: float the grid as a rounded card on the canvas (Stitch). */
.table-pane .table-body {
  padding: 16px;
  gap: 16px;
  background: var(--bg-app);
}
.table-pane .grid-host {
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
  background: var(--bg-panel);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
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
  padding: 9px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.toolbar .hint {
  color: var(--text-faint);
  font-size: 11px;
}
.toolbar .btn {
  padding: 5px 13px;
  border-radius: 999px;
}
.toolbar .select.sm {
  border-radius: 999px;
  padding: 4px 12px;
}
.view-toggle {
  display: inline-flex;
  gap: 0;
  padding: 2px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  -webkit-app-region: no-drag;
}
.view-toggle button {
  padding: 4px 14px;
  font-size: 12px;
  font-weight: 500;
  background: transparent;
  border: none;
  border-radius: 999px;
  color: var(--text-dim);
  transition: background 0.12s, color 0.12s;
}
.view-toggle button:hover {
  color: var(--text);
}
.view-toggle button.on {
  background: var(--bg-active);
  color: var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
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
  min-width: 64px;
  text-align: center;
}
.status-mini {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 12px;
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
.btn.is-saved {
  color: var(--accent);
}
.ai-btn {
  color: var(--accent);
}
.ai-btn:hover {
  background: var(--accent-soft);
}
.run-error-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.run-error-msg {
  flex: 1;
  white-space: pre-wrap;
}
.fix-btn {
  flex-shrink: 0;
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 4px 12px;
  font-family: var(--font);
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
.snippet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 5px;
}
.snippet-name {
  font-weight: 600;
  color: var(--text);
}
.history-item.snippet:hover .drop {
  opacity: 1;
}
.snippet .drop {
  opacity: 0.5;
  color: var(--danger);
  width: 20px;
  height: 20px;
  border-radius: 4px;
}
.snippet .drop:hover {
  background: rgba(229, 97, 106, 0.15);
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
