<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue'
import { useWorkspace } from '../stores/workspace'
import { useTabs, type Tab } from '../stores/tabs'
import { useUi } from '../stores/ui'
import Icon from './Icon.vue'
import SqlEditor from './SqlEditor.vue'
import ResultsGrid from './ResultsGrid.vue'
import RowDetailPanel from './RowDetailPanel.vue'
import StructurePanel from './StructurePanel.vue'
import FilterBar from './FilterBar.vue'
import ExportModal from './ExportModal.vue'
import ExportDbModal from './ExportDbModal.vue'
import ImportModal from './ImportModal.vue'
import TransferModal from './TransferModal.vue'
import NamePrompt from './NamePrompt.vue'
import CreateTableModal from './CreateTableModal.vue'
import DropTablesModal from './DropTablesModal.vue'
import DropAllObjectsModal from './DropAllObjectsModal.vue'
import TruncateTablesModal from './TruncateTablesModal.vue'
import CellValueModal from './CellValueModal.vue'
import ColumnStatsModal from './ColumnStatsModal.vue'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'
import { dialogOpen } from '../lib/dialog'
import ChatPanel from './ChatPanel.vue'
import { canChart, autoDetect } from '../lib/chartOption'
import RedisKeyModal from './RedisKeyModal.vue'
import { LANGUAGES as CODEGEN_LANGUAGES } from '../lib/codegen'
import AiAssistantModal from './AiAssistantModal.vue'
import QueryVarsModal from './QueryVarsModal.vue'
import PlanTreeModal from './PlanTreeModal.vue'
import BulkEditModal from './BulkEditModal.vue'
import DependenciesModal from './DependenciesModal.vue'
import TableSizesModal from './TableSizesModal.vue'
import ColumnSearchModal from './ColumnSearchModal.vue'
import SnapshotsModal from './SnapshotsModal.vue'
import RecoverDeletedModal from './RecoverDeletedModal.vue'
import CloneSqliteModal from './CloneSqliteModal.vue'
import RowHistoryModal from './RowHistoryModal.vue'
import TableNoteModal from './TableNoteModal.vue'
import BookmarksMenu from './BookmarksMenu.vue'
import type { ChartType, DropTableOptions, PlanBaseline, PlanNode, QueryResult, TruncateOptions } from '@shared/types'

import { serverDatabaseId, sqlDialect, supportsDropAllObjects, type FilterOp, type FilterSpec, type Snippet, type TableInfo } from '@shared/types'
import { formatSql } from '../lib/sql'
import { lintSql } from '../lib/sqlLint'
import { rowToJson, rowToCsv, rowToInsert, rowsToInserts, rowsToUpdates } from '../lib/rowCopy'
import { canExportToTable, planResultTable } from '../lib/resultTable'
import logoUrl from '../assets/logo.webp'

// Loaded on first use: these pull in the charting and code-generation libraries,
// which most sessions never open.
const ErDiagram = defineAsyncComponent(() => import('./ErDiagram.vue'))
const RecordExplorer = defineAsyncComponent(() => import('./RecordExplorer.vue'))
const RelatedRecords = defineAsyncComponent(() => import('./RelatedRecords.vue'))
const PerformanceDashboard = defineAsyncComponent(() => import('./PerformanceDashboard.vue'))
const InvestigationsPanel = defineAsyncComponent(() => import('./InvestigationsPanel.vue'))
const DocsPanel = defineAsyncComponent(() => import('./DocsPanel.vue'))
const SmartSearchPanel = defineAsyncComponent(() => import('./SmartSearchPanel.vue'))
const AnalyticsPanel = defineAsyncComponent(() => import('./AnalyticsPanel.vue'))
const ChartRender = defineAsyncComponent(() => import('./ChartRender.vue'))
const EnvDiffPanel = defineAsyncComponent(() => import('./EnvDiffPanel.vue'))
const SchemaDiffPanel = defineAsyncComponent(() => import('./SchemaDiffPanel.vue'))
const DataDiffPanel = defineAsyncComponent(() => import('./DataDiffPanel.vue'))
const RedisQueuePanel = defineAsyncComponent(() => import('./RedisQueuePanel.vue'))
const VisualQueryBuilder = defineAsyncComponent(() => import('./VisualQueryBuilder.vue'))
const DataGeneratorModal = defineAsyncComponent(() => import('./DataGeneratorModal.vue'))
const CodegenModal = defineAsyncComponent(() => import('./CodegenModal.vue'))

const ws = useWorkspace()
const tabsStore = useTabs()
const ui = useUi()

const tableFilter = ref('')
const newDbName = ref('')

const exportOpen = ref(false)
// Instant Visualization: per-query toggle between the data grid and a chart.
const qResultView = ref<'table' | 'chart'>('table')
const qChartType = ref<ChartType>('bar')
function showChartView(): void {
  if (active.value?.result) qChartType.value = autoDetect(active.value.result).type
  qResultView.value = 'chart'
}
// Label for a result-set sub-tab: row count for selects, command for writes.
function resultLabel(r: QueryResult, i: number): string {
  const n = `Result ${i + 1}`
  if (r.columns.length) return `${n} · ${r.rowCount} ${r.rowCount === 1 ? 'row' : 'rows'}`
  if (r.command) return `${n} · ${r.command}${r.affectedRows != null ? ` ${r.affectedRows}` : ''}`
  return n
}

const saveSnippetOpen = ref(false)
const createTableOpen = ref(false)
const exportTableTarget = ref<TableInfo | null>(null)
const genTarget = ref<TableInfo | null>(null)
const codegenTarget = ref<{ language: string; tables: TableInfo[] } | null>(null)
const aiOpen = ref(false)
const aiMode = ref<'generate' | 'explain' | 'fix'>('generate')

// Query variables: `{{name}}` placeholders are collected and substituted before
// the query runs, without altering the saved template.
const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g
const queryVars = ref<{ names: string[]; tab: Tab; source: string } | null>(null)

function runActive(tab: Tab, sqlOverride?: string): void {
  if (tab.kind === 'query') {
    // Run the selection/statement when given (⌘↵), else the whole buffer.
    const source = sqlOverride ?? tab.query
    const names = [...new Set([...source.matchAll(VAR_RE)].map((m) => m[1]))]
    if (names.length) {
      queryVars.value = { names, tab, source }
      return
    }
    if (sqlOverride !== undefined) {
      void tabsStore.run(tab, sqlOverride)
      return
    }
  }
  void tabsStore.run(tab)
}
function runWithVars(values: Record<string, string>): void {
  const pending = queryVars.value
  queryVars.value = null
  if (!pending) return
  const sql = pending.source.replace(VAR_RE, (_m, name: string) => values[name] ?? '')
  void tabsStore.run(pending.tab, sql)
}

function openAi(mode: 'generate' | 'explain' | 'fix'): void {
  aiMode.value = mode
  aiOpen.value = true
}

// Visual EXPLAIN — fetch the structured plan and show it as an interactive tree.
const planRoot = ref<PlanNode | null>(null)
const planLoading = ref(false)
// Regression alerts: compare this plan's top-node cost to a saved baseline.
const planBaseline = ref<PlanBaseline | null>(null)
const planCost = ref<number | null>(null)
const planBaselineJustSaved = ref(false)
const planTab = ref<Tab | null>(null)
async function openPlan(tab: Tab): Promise<void> {
  if (tab.kind !== 'query' || !tab.query.trim() || planLoading.value) return
  planLoading.value = true
  planTab.value = tab
  planBaseline.value = null
  planCost.value = null
  planBaselineJustSaved.value = false
  try {
    const root = await window.api.db.explainPlan(tab.connectionId, tab.query)
    if (root) {
      planRoot.value = root
      // Only cost-bearing plans (Postgres/Timescale) support regression alerts.
      if (typeof root.cost === 'number') {
        planCost.value = root.cost
        const existing = await window.api.planBaselines.get(tab.connectionId, tab.query)
        if (existing) {
          planBaseline.value = existing
        } else {
          // First view of this query: silently capture a baseline to compare against later.
          planBaseline.value = await window.api.planBaselines.set(
            tab.connectionId,
            tab.query,
            root.cost,
            root.rows
          )
          planBaselineJustSaved.value = true
        }
      }
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

// Re-capture the baseline for the plan currently shown (after a regression is intentional).
async function updatePlanBaseline(): Promise<void> {
  const tab = planTab.value
  if (!tab || planCost.value == null) return
  planBaseline.value = await window.api.planBaselines.set(
    tab.connectionId,
    tab.query,
    planCost.value,
    planRoot.value?.rows
  )
  planBaselineJustSaved.value = true
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
// A keyboard-triggered click has no pointer position; hang the menu off its button.
function menuOrigin(e: MouseEvent): { x: number; y: number } {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { x: r.left, y: r.bottom + 4 }
}
function openGenerateSqlMenu(e: MouseEvent): void {
  showGenerateSqlMenu(menuOrigin(e))
}
function showGenerateSqlMenu(origin: { x: number; y: number }): void {
  const a = active.value
  if (!a?.result || a.kind !== 'table' || !a.table) return
  const cols = a.result.columns
  const rows = [...a.selection].sort((x, y) => x - y).map((i) => a.result!.rows[i] as unknown[])
  const table = a.table.name
  ctx.value = {
    ...origin,
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
// Column nullability for the row detail panel's "Set NULL" toggles. Lazily loads
// the table structure (SQL engines only) the first time a row is opened.
function nullableMap(tab: Tab): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const c of tab.structure?.columns ?? []) map[c.name] = c.nullable
  return map
}
function onSelectRow(tab: Tab, r: number): void {
  tab.selectedRow = r
  if (!nonSql.value && !tab.structure) void tabsStore.loadStructure(tab)
}

// ---- time-travel row history -----------------------------------------------
const rowHistoryTarget = ref<{ connId: string; table: string; pk: Record<string, unknown>; label: string } | null>(null)
function openRowHistory(tab: Tab, rowIndex: number): void {
  if (tab.kind !== 'table' || !tab.table || !tab.result || !tab.primaryKeys.length) return
  const row = tab.result.rows[rowIndex] as unknown[]
  const pk: Record<string, unknown> = {}
  for (const k of tab.primaryKeys) {
    const i = tab.result.columns.findIndex((c) => c.name === k)
    if (i >= 0) pk[k] = row[i]
  }
  rowHistoryTarget.value = {
    connId: tab.connectionId,
    table: tab.table.name,
    pk,
    label: `${tab.table.name} #${Object.values(pk).map(String).join(', ')}`
  }
}
/** Restore a row to an earlier set of column values (a single staged update). */
function revertRow(values: Record<string, unknown>): void {
  const tab = active.value
  const target = rowHistoryTarget.value
  if (!tab || tab.kind !== 'table' || !target || !tab.result) return
  // Find the live row matching the target PK.
  const rowIndex = tab.result.rows.findIndex((row) =>
    tab.primaryKeys.every((k) => {
      const i = tab.result!.columns.findIndex((c) => c.name === k)
      return i >= 0 && String((row as unknown[])[i]) === String(target.pk[k])
    })
  )
  if (rowIndex < 0) {
    ws.error = 'That row is no longer in the current page — reload to revert it.'
    rowHistoryTarget.value = null
    return
  }
  for (const c of tab.result.columns) {
    if (tab.primaryKeys.includes(c.name)) continue
    if (c.name in values) tabsStore.editCell(tab, rowIndex, c.name, values[c.name])
  }
  rowHistoryTarget.value = null
}

// ---- cell value viewer (JSON / long text) ----------------------------------
const cellViewer = ref<{
  tab: Tab
  rowIndex: number
  column: string
  value: unknown
  editable: boolean
} | null>(null)
function openCellViewer(tab: Tab, rowIndex: number, colIndex: number): void {
  const row = tab.result?.rows[rowIndex]
  const col = tab.result?.columns[colIndex]
  if (!row || !col) return
  cellViewer.value = {
    tab,
    rowIndex,
    column: col.name,
    value: row[colIndex],
    editable: tabsStore.editsAllowed(tab)
  }
}
function saveCellValue(value: string): void {
  const cv = cellViewer.value
  cellViewer.value = null
  if (cv) tabsStore.editCell(cv.tab, cv.rowIndex, cv.column, value)
}
// ---- column stats (right-click a column header) ----------------------------
const statsTarget = ref<{ table: TableInfo; column: string } | null>(null)
function onHeaderContext(tab: Tab, column: string, e: MouseEvent): void {
  if (tab.kind !== 'table' || !tab.table || nonSql.value) return
  const t = tab.table
  ctx.value = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: 'Column stats…', action: () => (statsTarget.value = { table: t, column }) },
      { label: 'Copy column name', action: () => copyText(column) }
    ]
  }
}

/** True when a cell value reads as JSON (object/array). */
function looksJson(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (s.length < 2 || (s[0] !== '{' && s[0] !== '[')) return false
  try {
    const d = JSON.parse(s)
    return d !== null && typeof d === 'object'
  } catch {
    return false
  }
}

function onRowContext(tab: Tab, rowIndex: number, e: MouseEvent, colIndex?: number): void {
  const result = tab.result
  if (!result || !result.columns.length) return
  const row = result.rows[rowIndex] as unknown[]
  if (!row) return
  const table = tab.kind === 'table' && tab.table ? tab.table.name : 'table'
  const items: MenuItem[] = []
  // Cell-specific actions for the column that was right-clicked.
  if (colIndex != null && colIndex >= 0 && colIndex < row.length) {
    const cell = row[colIndex]
    const column = result.columns[colIndex].name
    items.push({ label: 'Copy cell value', action: () => copyText(cell == null ? '' : String(cell)) })
    items.push({
      label: looksJson(cell) ? 'View JSON…' : 'View value…',
      action: () => openCellViewer(tab, rowIndex, colIndex)
    })
    // Set to NULL — editable table tabs, only when the cell isn't already NULL.
    if (tabsStore.editsAllowed(tab) && cell != null) {
      items.push({ label: 'Set to NULL', action: () => tabsStore.setCellNull(tab, rowIndex, column) })
    }
    // Filter by this value — reloadable table tabs on SQL engines.
    if (tab.kind === 'table' && tab.table && !nonSql.value) {
      if (cell == null) {
        items.push(
          { label: 'Filter: is NULL', action: () => addCellFilter(tab, column, 'is null') },
          { label: 'Filter: is not NULL', action: () => addCellFilter(tab, column, 'not null') }
        )
      } else {
        const disp = String(cell)
        const short = disp.length > 24 ? `${disp.slice(0, 24)}…` : disp
        items.push(
          { label: `Filter: = ${short}`, action: () => addCellFilter(tab, column, '=', disp) },
          { label: `Filter: ≠ ${short}`, action: () => addCellFilter(tab, column, '!=', disp) }
        )
      }
    }
    items.push({ sep: true })
  }
  // View the full Redis value (handles every type, including non-strings).
  if (isRedis.value && tab.kind === 'table') {
    const keyIdx = result.columns.findIndex((c) => c.name === 'key')
    const key = keyIdx >= 0 ? row[keyIdx] : undefined
    if (key != null) {
      items.push(
        { label: 'View value', action: () => (redisKeyTarget.value = String(key)) },
        { sep: true }
      )
    }
  }
  // Explore record — drill through FK relationships (SQL tables with a PK).
  if (!nonSql.value && tab.kind === 'table' && tab.table && tab.primaryKeys.length) {
    const pkCol = tab.primaryKeys[0]
    const pkIdx = result.columns.findIndex((c) => c.name === pkCol)
    if (pkIdx >= 0) {
      const value = row[pkIdx]
      const tableName = tab.table.name
      items.push(
        {
          label: 'Explore record',
          action: () =>
            tabsStore.openExplorer(tab.connectionId, {
              table: tableName,
              column: pkCol,
              value,
              label: `${tableName} #${String(value)}`
            })
        },
        {
          label: 'Related records',
          action: () =>
            tabsStore.openRelated(tab.connectionId, {
              table: tableName,
              column: pkCol,
              value,
              label: `${tableName} #${String(value)}`
            })
        },
        { label: 'Row history…', action: () => openRowHistory(tab, rowIndex) },
        { sep: true }
      )
    }
  }
  if (tabsStore.editsAllowed(tab)) {
    // If the right-clicked row is part of a multi-selection, act on the whole set.
    const multi = tab.selection.length > 1 && tab.selection.includes(rowIndex)
    items.push(
      { label: 'Duplicate row', action: () => tabsStore.duplicateRow(tab, rowIndex) },
      multi
        ? { label: `Delete ${tab.selection.length} rows`, danger: true, shortcut: '⌫', action: () => tabsStore.deleteSelectedRows(tab) }
        : { label: 'Delete row', danger: true, shortcut: '⌫', action: () => tabsStore.toggleDelete(tab, rowIndex) },
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

// Keyboard shortcuts (⌘A, ⌫, Esc) act on the list only after it was last clicked,
// so they don't hijack select-all or row deletion in the grid and editor.
const tableListEl = ref<HTMLElement | null>(null)
const tableListActive = ref(false)
function trackTableListFocus(e: Event): void {
  tableListActive.value = !!tableListEl.value?.contains(e.target as Node)
}
onMounted(() => {
  window.addEventListener('pointerdown', trackTableListFocus, true)
  window.addEventListener('focusin', trackTableListFocus)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', trackTableListFocus, true)
  window.removeEventListener('focusin', trackTableListFocus)
})

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
    { label: ws.tableNote(id, t.name) ? 'Edit note…' : 'Add note…', action: () => (noteTarget.value = t) },
    { label: 'Export table…', action: () => (exportTableTarget.value = { schema: t.schema, name: t.name, type: t.type }) }
  ]
  if (!nonSql.value) {
    items.push({
      label: 'Generate code',
      children: CODEGEN_LANGUAGES.map((lang) => ({
        label: lang,
        action: () => {
          const sel = ws.tables.filter((x) => selectedTables.value.includes(tableKey(x)))
          codegenTarget.value = {
            language: lang,
            tables: sel.length ? sel : [{ schema: t.schema, name: t.name, type: t.type }]
          }
        }
      }))
    })
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
        label: multiSelect.value ? `Truncate ${selectedTables.value.length} tables…` : 'Truncate data…',
        danger: true,
        action: openTruncateModal
      },
      {
        label: multiSelect.value ? `Delete ${selectedTables.value.length} tables…` : 'Delete table…',
        danger: true,
        action: openDropModal
      }
    )
    if (supportsDropAllObjects(activeConn.value?.driver ?? ''))
      items.push({ label: 'Drop all objects…', danger: true, action: () => (ui.dropAllOpen = true) })
  }
  ctx.value = { x: e.clientX, y: e.clientY, items }
}

// Generate code for the entire database — a language menu that opens the modal
// scoped to every table/view of the active connection.
// Narrow windows fold secondary toolbar actions into these menus.
function openTopbarMenu(e: MouseEvent): void {
  const c = activeConn.value
  if (!c) return
  const origin = menuOrigin(e)
  const items: MenuItem[] = [
    { label: 'Chat with your data', action: () => ui.toggleChatDock() },
    { label: 'Visual query builder', action: () => tabsStore.openVisualQuery(c.id) },
    { label: 'Investigate', action: () => tabsStore.openInvestigations(c.id) },
    { label: 'Analytics', action: () => tabsStore.openAnalytics(c.id) }
  ]
  if (!nonSql.value)
    items.push({
      label: 'Generate code',
      disabled: !ws.tables.length,
      children: ws.tables.length ? codegenItems() : undefined
    })
  if (!nonSql.value && !readOnly.value && !ws.txn[c.id])
    items.push({ label: 'Begin transaction', action: () => void ws.beginTxn(c.id) })
  items.push({ sep: true }, { label: 'Disconnect', action: () => void disconnect() })
  ctx.value = { ...origin, items }
}
function openQueryMenu(e: MouseEvent): void {
  const a = active.value
  if (!a) return
  const blank = !a.query.trim()
  const items: MenuItem[] = []
  if (explainable.value)
    items.push({ label: 'Explain', disabled: blank || a.running, action: () => void tabsStore.explain(a) })
  if (visualExplainable.value)
    items.push({ label: 'Plan', disabled: blank || a.running || planLoading.value, action: () => void openPlan(a) })
  if (!nonSql.value)
    items.push(
      { label: 'Format', shortcut: '⌘⇧F', disabled: blank, action: () => formatActive() },
      { label: 'Generate SQL with AI', action: () => openAi('generate') },
      {
        label: 'Investigate this query',
        disabled: blank,
        action: () => tabsStore.openInvestigations(a.connectionId, { type: 'query', sql: a.query })
      }
    )
  items.push(
    { label: 'Chat with your data', action: () => ui.openChatDock() },
    { sep: true },
    { label: 'Save query', disabled: blank, action: () => openSaveSnippet() },
    { label: 'Export', disabled: !a.result, action: () => (exportOpen.value = true) }
  )
  if (canResultToTable.value)
    items.push({ sep: true }, { label: 'Save result as table', action: () => (toTableOpen.value = true) })
  ctx.value = { ...menuOrigin(e), items }
}
function openTableMenu(e: MouseEvent): void {
  const a = active.value
  if (!a) return
  const origin = menuOrigin(e)
  const items: MenuItem[] = [
    { label: 'Previous page', disabled: a.offset === 0 || a.running, action: () => void tabsStore.prevPage(a) },
    {
      label: 'Next page',
      disabled: a.running || !a.result || a.result.rows.length < a.pageSize,
      action: () => void tabsStore.nextPage(a)
    },
    { sep: true },
    { label: 'Refresh', shortcut: '⌘R', action: () => void tabsStore.reloadTable(a) },
    {
      label: 'Rows per page',
      children: [100, 200, 500, 1000].map((n) => ({
        label: n === a.pageSize ? `${n} (current)` : String(n),
        action: () => void tabsStore.setPageSize(a, n)
      }))
    },
    { sep: true }
  ]
  if (tabsStore.editsAllowed(a))
    items.push(
      {
        label: 'Discard changes',
        danger: true,
        disabled: !tabsStore.dirtyCount(a),
        action: () => tabsStore.discardEdits(a)
      },
      { label: 'Add row', action: () => tabsStore.addInsertRow(a) },
      { label: 'Bulk edit', disabled: !a.selection.length, action: () => (bulkOpen.value = true) },
      { label: 'Generate SQL', disabled: !a.selection.length, action: () => showGenerateSqlMenu(origin) },
      { sep: true }
    )
  items.push(
    { label: 'Save result as table', disabled: !canResultToTable.value, action: () => (toTableOpen.value = true) },
    { label: 'Export', disabled: !a.result, action: () => (exportOpen.value = true) }
  )
  ctx.value = { ...origin, items }
}
function codegenItems(): MenuItem[] {
  const tables = ws.tables.map((t) => ({ schema: t.schema, name: t.name, type: t.type }))
  return CODEGEN_LANGUAGES.map((language) => ({
    label: language,
    action: () => (codegenTarget.value = { language, tables })
  }))
}
function openDbCodegen(e: MouseEvent): void {
  if (ws.tables.length) ctx.value = { ...menuOrigin(e), items: codegenItems() }
}

// ---- per-table notes (local) -----------------------------------------------
const noteTarget = ref<TableInfo | null>(null)
async function saveNote(text: string): Promise<void> {
  if (noteTarget.value && activeConn.value) {
    await ws.setTableNote(activeConn.value.id, noteTarget.value.name, text)
  }
  noteTarget.value = null
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
  // Views first: they may depend on the tables being dropped.
  const ordered = [...sel.filter((t) => t.type === 'view'), ...sel.filter((t) => t.type !== 'view')]
  if (ordered.length) dropTargets.value = ordered.map((t) => ({ schema: t.schema, name: t.name, type: t.type }))
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

async function onDroppedAll(connId: string): Promise<void> {
  for (const tab of tabsStore.forConnection(connId)) {
    if (tab.kind === 'table') tabsStore.closeTab(tab.id)
  }
  selectedTables.value = []
  await ws.refreshTables(connId)
}

// ---- truncate modal --------------------------------------------------------
const truncateTargets = ref<TableInfo[] | null>(null)
function openTruncateModal(): void {
  const sel = ws.tables.filter((t) => selectedTables.value.includes(tableKey(t)))
  if (sel.length) truncateTargets.value = sel.map((t) => ({ schema: t.schema, name: t.name, type: t.type }))
}
async function performTruncate(opts: TruncateOptions): Promise<void> {
  const conn = activeConn.value
  const targets = truncateTargets.value
  truncateTargets.value = null
  if (!conn || !targets) return
  try {
    await window.api.db.truncateTables(conn.id, targets, opts)
    // Structure is unchanged — just reload the data of any open tabs for these tables.
    const names = new Set(targets.map((t) => t.name))
    for (const tab of tabsStore.forConnection(conn.id)) {
      if (tab.kind === 'table' && tab.table && names.has(tab.table.name)) void tabsStore.reloadTable(tab)
    }
    selectedTables.value = []
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

const refreshingTables = ref(false)
async function refreshTableList(): Promise<void> {
  const conn = activeConn.value
  if (!conn || refreshingTables.value) return
  refreshingTables.value = true
  try {
    await ws.refreshTables(conn.id)
  } finally {
    refreshingTables.value = false
  }
}
// Standalone chat session for the slide-out dock, tied to the active connection.
const dockChat = computed(() =>
  activeConn.value ? tabsStore.dockChatFor(activeConn.value.id) : null
)

// Inline SQL lint hints for the active query tab (non-blocking, collapsible).
const lintsOpen = ref(false)
const activeLints = computed(() => {
  const a = active.value
  if (!a || a.kind !== 'query' || nonSql.value || !a.query.trim()) return []
  return lintSql(a.query)
})
const lintWarnCount = computed(() => activeLints.value.filter((l) => l.severity === 'warn').length)


// Foreign-key map for the active table tab (column -> {toTable,toColumn}), so
// the grid can show inline "jump to related row" arrows on FK cells.
const activeFkColumns = computed<Record<string, { toTable: string; toColumn: string }>>(() => {
  const a = active.value
  if (!a || a.kind !== 'table' || !a.table) return {}
  const er = ws.erModels[a.connectionId]
  const map: Record<string, { toTable: string; toColumn: string }> = {}
  if (er) {
    for (const rel of er.relations) {
      if (rel.fromTable === a.table.name) {
        map[rel.fromColumn] = { toTable: rel.toTable, toColumn: rel.toColumn }
      }
    }
  }
  return map
})

// Open the related row when a foreign-key arrow is clicked in the grid.
function onFkNavigate(column: string, value: unknown): void {
  const a = active.value
  if (!a || a.kind !== 'table') return
  const fk = activeFkColumns.value[column]
  if (!fk) return
  const target: TableInfo =
    ws.tables.find((t) => t.name === fk.toTable) ?? { name: fk.toTable, type: 'table' }
  tabsStore.openTableFiltered(a.connectionId, target, fk.toColumn, value)
}
const isInflux = computed(() => activeConn.value?.driver === 'influxdb')
const isMongo = computed(() => activeConn.value?.driver === 'mongodb')
const isRedis = computed(() => activeConn.value?.driver === 'redis')
/** When set, RedisKeyModal shows the full value of this key. */
const redisKeyTarget = ref<string | null>(null)
// Engines that don't speak SQL — gate SQL-only affordances (Format, AI, the
// structure editor, EXPLAIN) off these.
const nonSql = computed(() => isInflux.value || isMongo.value || isRedis.value)
const readOnly = computed(() => !!activeConn.value && ws.isReadOnly(activeConn.value.id))
// A read-only connection currently unlocked for writes (shows a countdown).
const writeUnlocked = computed(
  () => !!activeConn.value?.readOnly && !readOnly.value
)
const unlockCountdown = computed(() => {
  if (!activeConn.value) return ''
  const s = ws.unlockSecondsLeft(activeConn.value.id)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
async function unlockWrites(): Promise<void> {
  const c = activeConn.value
  if (!c) return
  const ok = await ui.confirmDialog({
    title: 'Allow writes',
    message: c.production
      ? `${c.name} is a production connection. Allow writes for 15 minutes?`
      : `Allow writes to “${c.name}” for 15 minutes?`,
    confirmLabel: 'Allow writes',
    danger: c.production
  })
  if (ok) ws.unlockWrites(c.id, 15)
}
function relockWrites(): void {
  if (activeConn.value) ws.relockWrites(activeConn.value.id)
}
const isProduction = computed(() => !!activeConn.value?.production)
// Oracle maps to the postgres dialect for quoting, but its EXPLAIN / cancel
// syntax differs — exclude it from the dialect-based gating below.
const isOracle = computed(() => activeConn.value?.driver === 'oracle')
const explainable = computed(() =>
  !isOracle.value && ['postgres', 'mysql', 'sqlite'].includes(sqlDialect(activeConn.value?.driver ?? ''))
)
// Engines that can abort an in-flight query (SQLite runs synchronously, can't).
const cancellable = computed(
  () =>
    !nonSql.value &&
    !isOracle.value &&
    ['postgres', 'mysql', 'mssql'].includes(sqlDialect(activeConn.value?.driver ?? ''))
)
// Visual EXPLAIN — only engines that expose a structured plan. Of the pg-wire
// family only real Postgres + TimescaleDB support `EXPLAIN (FORMAT JSON)`.
const visualExplainable = computed(() =>
  ['postgres', 'sqlite', 'timescaledb'].includes(activeConn.value?.driver ?? '')
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

// Lazily load the FK graph whenever a table tab on this connection is shown.
watch(
  () => (active.value?.kind === 'table' ? active.value.connectionId : null),
  (cid) => {
    if (cid && !ws.erModels[cid]) void ws.loadErModel(cid).catch(() => {})
  },
  { immediate: true }
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

function onTableListKeydown(e: KeyboardEvent): boolean {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
    selectedTables.value = filteredTables.value.map(tableKey)
    selAnchor = 0
  } else if (e.key === 'Escape' && selectedTables.value.length) {
    selectedTables.value = []
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && selectedTables.value.length) {
    if (!nonSql.value && !readOnly.value && !dropTargets.value) openDropModal()
  } else {
    return false
  }
  e.preventDefault()
  return true
}

function onKeydown(e: KeyboardEvent): void {
  if (dialogOpen()) return
  const a = active.value

  if (tableListActive.value && !inEditableField() && onTableListKeydown(e)) return

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

  // Backspace / Delete: mark the selected data rows for deletion (unless typing in
  // a field). Dropping tables is only ever offered from the focused table list.
  if (e.key !== 'Backspace' && e.key !== 'Delete') return
  if (inEditableField()) return
  if (a && a.kind === 'table' && a.viewMode === 'data' && tabsStore.editsAllowed(a)) {
    // Checkbox multi-selection takes precedence — delete them all at once.
    if (a.selection.length) {
      e.preventDefault()
      tabsStore.deleteSelectedRows(a)
      return
    }
    if (a.selectedRow !== null) {
      e.preventDefault()
      tabsStore.toggleDelete(a, a.selectedRow)
      return
    }
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function openTable(t: TableInfo): void {
  if (ws.activeConnectionId) tabsStore.openTable(ws.activeConnectionId, t)
}
watch(
  () => active.value?.id,
  async () => {
    await nextTick()
    document
      .querySelector('.tab-strip [role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
)
async function closeTabFromKeyboard(tab: Tab): Promise<void> {
  if (!(await tabsStore.requestCloseTab(tab.id))) return
  await nextTick()
  document.querySelector<HTMLElement>('.tab-strip [role="tab"][aria-selected="true"]')?.focus()
}
function newQuery(): void {
  if (ws.activeConnectionId) tabsStore.openQuery(ws.activeConnectionId)
}

// Drag-to-resize the tables list / row-detail panel. The detail handle lives on
// the panel's left edge, so dragging left widens it.
function startResize(which: 'tables' | 'detail', e: MouseEvent): void {
  e.preventDefault()
  const startX = e.clientX
  const startW = which === 'tables' ? ui.tablesWidth : ui.detailWidth
  const move = (ev: MouseEvent): void => {
    const dx = ev.clientX - startX
    if (which === 'tables') ui.setTablesWidth(startW + dx)
    else ui.setDetailWidth(startW - dx)
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
async function disconnect(): Promise<void> {
  if (ws.activeConnectionId) await tabsStore.disconnect(ws.activeConnectionId)
}

// pagination helpers
const pageInfo = (tab: Tab): string => {
  const n = tab.result?.rows.length ?? 0
  // Append the true total once it's known (e.g. "1–200 of 12,345").
  const total = tab.totalRows !== null ? ` of ${tab.totalRows.toLocaleString()}` : ''
  if (n === 0) return tab.offset > 0 ? `from ${tab.offset + 1}${total}` : `0 rows${total}`
  return `${tab.offset + 1}–${tab.offset + n}${total}`
}
function onApplyFilters(tab: Tab, filters: FilterSpec[]): void {
  tabsStore.setFilters(tab, filters)
}
/** Append a filter built from a right-clicked cell, then reload the table. */
function addCellFilter(tab: Tab, column: string, op: FilterOp, value?: string): void {
  tabsStore.setFilters(tab, [...tab.filters, { column, op, value }])
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
    syncServerDatabases(tab.connectionId)
  } catch (e) {
    tab.error = e instanceof Error ? e.message : String(e)
  }
}
async function dropDatabase(tab: Tab, name: string): Promise<void> {
  const ok = await ui.confirmDialog({
    title: 'Drop database',
    message: `Drop database "${name}"? This cannot be undone.`,
    confirmLabel: 'Drop database',
    danger: true
  })
  if (!ok) return
  try {
    await window.api.db.dropDatabase(tab.connectionId, name)
    await tabsStore.run(tab)
    syncServerDatabases(tab.connectionId)
  } catch (e) {
    tab.error = e instanceof Error ? e.message : String(e)
  }
}
function syncServerDatabases(connId: string): void {
  if (ws.findConnection(connId)?.serverMode) void ws.loadServerDatabases(connId)
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
// ---- execution-time history (visual durations) -----------------------------
const histTimes = computed(() =>
  (active.value?.entries ?? []).filter((h) => !h.error && h.durationMs != null).map((h) => h.durationMs as number)
)
const histMaxMs = computed(() => Math.max(1, ...histTimes.value))
const histAvgMs = computed(() =>
  histTimes.value.length ? Math.round(histTimes.value.reduce((a, b) => a + b, 0) / histTimes.value.length) : 0
)
function durPct(ms?: number): number {
  return ms ? Math.max(2, Math.round((ms / histMaxMs.value) * 100)) : 0
}
/** fast (<100ms) · mid (<1s) · slow (≥1s) — for colour-coding the bar. */
function durClass(ms?: number): string {
  if (ms == null) return ''
  return ms < 100 ? 'fast' : ms < 1000 ? 'mid' : 'slow'
}

async function killProcess(tab: Tab, row: unknown[]): Promise<void> {
  const pid = row[0]
  if (pid == null) return
  const ok = await ui.confirmDialog({
    title: 'Kill process',
    message: `Kill process ${pid}? Its running statement is aborted.`,
    confirmLabel: 'Kill process',
    danger: true
  })
  if (!ok) return
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
      <button class="icon-btn" title="Show or hide the sidebar (⌘B)" @click="ui.toggleSidebar()"><Icon name="menu" /></button>
      <template v-if="activeConn">
        <span class="dot" :style="{ background: activeConn.color || 'var(--text-faint)' }" />
        <h1 class="conn-name">{{ activeConn.name }}</h1>
        <span class="meta">{{ activeConn.driver }}<template v-if="activeConn.database"> · {{ activeConn.database }}</template></span>
        <span class="state" :class="ws.connStates[activeConn.id] || 'disconnected'" />
        <button
          v-if="readOnly"
          class="ro-badge locked"
          title="Read-only" data-tip="Click to allow writes for 15 minutes. You are asked to confirm."
          @click="unlockWrites"
        ><Icon name="lock" :size="12" /> Read-only</button>
        <button
          v-else-if="writeUnlocked"
          class="ro-badge unlocked"
          title="Writes are unlocked" data-tip="Click to make this connection read-only again now."
          @click="relockWrites"
        ><Icon name="unlock" :size="12" /> Writable {{ unlockCountdown }}</button>
      </template>
      <strong v-else class="brand-title">DataDock</strong>
      <div class="spacer drag" />
      <button class="icon-btn palette-btn" title="Command palette (⌘K)" data-tip="Search connections, tables and actions." aria-label="Command palette" @click="ui.openPalette()">⌘K</button>
      <button class="icon-btn theme-btn" :title="ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'" @click="ui.toggleTheme()">
        <Icon :name="ui.theme === 'dark' ? 'sun' : 'moon'" />
      </button>
      <template v-if="activeConn">
        <template v-if="!nonSql && !readOnly">
          <template v-if="ws.txn[activeConn.id]">
            <span class="txn-badge" data-tooltip="Transaction open" data-tip="Your changes are not saved until you commit."><span class="tx-dot" /> TX</span>
            <button class="btn btn-ghost txn-commit" title="Commit transaction" data-tip="Makes every change since Begin Tx permanent." @click="ws.commitTxn(activeConn.id)">Commit</button>
            <button class="btn btn-ghost txn-rollback" title="Roll back transaction" data-tip="Discards every change since Begin Tx." @click="ws.rollbackTxn(activeConn.id)">Rollback</button>
          </template>
          <button v-else class="btn btn-ghost fold" title="Begin transaction" data-tip="Changes on this connection stay uncommitted until you press Commit." @click="ws.beginTxn(activeConn.id)"><Icon name="swap" /> Begin Tx</button>
          <span class="bar-sep fold" />
        </template>
        <button
          class="btn btn-ghost ai-btn fold"
          :class="{ on: ui.chatDockOpen }"
          title="Chat with your data"
          data-tip="Opens the AI side panel. It can only read."
          :aria-pressed="ui.chatDockOpen"
          @click="ui.toggleChatDock()"
        ><Icon name="sparkles" /> <span class="lbl">Chat</span></button>
        <button class="btn btn-ghost fold" title="Visual query builder" data-tip="Opens a tab to build a query without SQL. Nothing runs until you press Run." @click="tabsStore.openVisualQuery(activeConn.id)"><Icon name="diagram" /> <span class="lbl">Builder</span></button>
        <button class="btn btn-ghost fold" title="Investigate" data-tip="Opens a tab with AI checks for slow queries and database health. Read-only." @click="tabsStore.openInvestigations(activeConn.id)"><Icon name="target" /> <span class="lbl">Investigate</span></button>
        <button class="btn btn-ghost fold" title="Analytics" data-tip="Opens a tab with charts and dashboards." @click="tabsStore.openAnalytics(activeConn.id)"><Icon name="chart" /> <span class="lbl">Analytics</span></button>
        <button v-if="!nonSql" class="btn btn-ghost fold" title="Generate code" data-tip="Choose a language to generate models, migrations or schemas. The database is not changed." aria-haspopup="menu" :disabled="!ws.tables.length" @click="openDbCodegen($event)"><Icon name="code" /> <span class="lbl">Code</span></button>
        <span class="bar-sep fold" />
        <button class="btn btn-ghost" title="New query (⌘T)" data-tip="Opens an empty query tab." @click="newQuery"><Icon name="plus" /> <span class="lbl-keep">Query</span></button>
        <button class="btn fold" title="Disconnect" data-tip="Closes the connection to this database. Your tabs stay open." @click="disconnect"><Icon name="power" /> Disconnect</button>
        <button class="btn btn-ghost more" title="More actions" aria-haspopup="menu" @click="openTopbarMenu"><Icon name="more" /></button>
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
      <Transition name="drop">
        <div v-if="isProduction" class="prod-banner">
          <Icon name="warn" :size="13" /> PRODUCTION — {{ activeConn.name }}. Changes here affect live data.
        </div>
      </Transition>
      <Transition name="drop">
        <div v-if="ws.error" class="conn-error" role="alert">{{ ws.error }}</div>
      </Transition>

      <div class="work">
        <!-- Table list -->
        <div class="tables" v-show="!ui.tablesCollapsed" :style="{ width: ui.tablesWidth + 'px' }">
          <div class="tables-head">
            <input class="input filter" v-model="tableFilter" aria-label="Filter tables" placeholder="Filter" />
            <button class="icon-btn sm" title="Reload table list (⌘⇧R)" :disabled="!activeConn || refreshingTables" @click="refreshTableList"><Icon name="refresh" :size="14" :class="{ spin: refreshingTables }" :data-busy="refreshingTables || undefined" /></button>
            <button v-if="!nonSql && !readOnly" class="icon-btn sm" title="New table" data-tip="Opens a form. Nothing is created until you confirm." @click="createTableOpen = true"><Icon name="plus" :size="14" /></button>
            <button v-if="!nonSql" class="icon-btn sm" title="Generate code" data-tip="Models, migrations or schemas for every table. The database is not changed." :disabled="!activeConn || !ws.tables.length" @click="openDbCodegen($event)"><Icon name="code" :size="14" /></button>
            <button class="icon-btn sm" title="Hide table list" @click="ui.toggleTables()"><Icon name="chevronLeft" :size="14" /></button>
          </div>
          <div ref="tableListEl" class="table-list" role="listbox" aria-label="Tables" aria-multiselectable="true" data-rows>
            <div
              v-for="(t, idx) in filteredTables"
              :key="(t.schema || '') + t.name"
              v-row
              role="option"
              :aria-selected="isSelected(t)"
              class="table-item"
              :class="{ selected: isSelected(t) }"
              @click="onTableClick(t, idx, $event)"
              @contextmenu.prevent="onTableContext(t, idx, $event)"
            >
              <span class="ticon"><Icon :name="t.type === 'view' ? 'view' : 'table'" :size="14" /></span>
              <span class="tname">{{ t.name }}</span>
              <span
                v-if="activeConn && ws.tableNote(activeConn.id, t.name)"
                class="tnote"
                :title="ws.tableNote(activeConn.id, t.name)"
              ><Icon name="note" :size="12" /></span>
            </div>
            <div v-if="filteredTables.length === 0" class="no-tables">No tables</div>
          </div>
          <div v-if="multiSelect" class="sel-hint">{{ selectedTables.length }} selected · ⌫ to delete · esc to clear</div>
        </div>
        <div
          v-show="!ui.tablesCollapsed"
          class="resizer"
          title="Drag or use the arrow keys to resize"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-label="Tables list width"
          aria-valuemin="160"
          aria-valuemax="440"
          :aria-valuenow="ui.tablesWidth"
          @keydown.left.prevent="ui.setTablesWidth(ui.tablesWidth - 16)"
          @keydown.right.prevent="ui.setTablesWidth(ui.tablesWidth + 16)"
          @mousedown="startResize('tables', $event)"
        />
        <button v-if="ui.tablesCollapsed" class="tables-expand" title="Show tables" @click="ui.toggleTables()"><Icon name="chevronRight" :size="14" /></button>

        <!-- Tabs + content -->
        <div class="tab-area">
          <div class="tab-strip">
          <TransitionGroup name="tabs" tag="div" class="tab-list" role="tablist" aria-label="Open tabs" data-rows="horizontal">
            <div
              v-for="tab in connTabs"
              :key="tab.id"
              v-row
              role="tab"
              :aria-selected="active?.id === tab.id"
              aria-keyshortcuts="Delete"
              class="tab"
              :class="{ on: active?.id === tab.id }"
              @click="tabsStore.setActive(activeConn.id, tab.id)"
              @keydown.delete.stop.prevent="closeTabFromKeyboard(tab)"
              @mousedown.middle.prevent
              @mouseup.middle="tabsStore.requestCloseTab(tab.id)"
            >
              <span class="tab-kind" :class="tab.kind" />
              <span class="tab-title">{{ tab.title }}</span>
              <span v-if="tab.kind === 'table' && tabsStore.dirtyCount(tab)" class="tab-dirty" data-tooltip="Unsaved changes"><span class="sr-only">unsaved</span></span>
              <span class="tab-close" aria-hidden="true" data-tooltip="Close tab (⌘W)" @click.stop="tabsStore.requestCloseTab(tab.id)"><Icon name="x" :size="12" /></span>
            </div>
          </TransitionGroup>
            <button class="tab-add" title="New query (⌘T)" @click="newQuery"><Icon name="plus" :size="15" /></button>
          </div>

          <div v-if="!active" class="no-tab">
            <p>No tab open. Click a table or start a query.</p>
            <button class="btn btn-primary" @click="newQuery">New query</button>
          </div>

          <!-- Query tab -->
          <div v-else-if="active.kind === 'query'" class="editor-pane">
            <div class="toolbar">
              <div class="tb-group">
                <button
                  class="btn btn-primary"
                  :disabled="active.running"
                  title="Run all statements (⌘⇧↵)" data-tip="⌘↵ runs only the selection or the statement at the cursor."
                  @click="runActive(active)"
                >
                  <Icon name="play" :size="13" /> {{ active.running ? 'Running…' : 'Run' }}
                </button>
                <button
                  v-if="active.running && cancellable"
                  class="btn btn-ghost cancel-btn"
                  title="Cancel the running query"
                  @click="tabsStore.cancel(active)"
                ><Icon name="stop" :size="13" /> Cancel</button>
                <span class="hint">{{ isMongo ? 'MongoDB' : isInflux ? 'Flux' : 'SQL' }} · ⌘↵ selection · ⌘⇧↵ all</span>
              </div>
              <div class="tb-group fold">
                <button v-if="explainable" class="btn btn-ghost" :disabled="!active.query.trim() || active.running" title="Explain" data-tip="Shows the query plan as text." @click="tabsStore.explain(active)"><Icon name="explain" /> <span class="lbl">Explain</span></button>
                <button v-if="visualExplainable" class="btn btn-ghost" :disabled="!active.query.trim() || active.running || planLoading" title="Plan" data-tip="Shows the query plan as a tree." @click="openPlan(active)"><Icon name="plan" /> <span class="lbl">{{ planLoading ? 'Plan…' : 'Plan' }}</span></button>
                <button v-if="!nonSql" class="btn btn-ghost" :disabled="!active.query.trim()" title="Format SQL (⌘⇧F)" data-tip="Reformats the text in the editor. Nothing runs." @click="formatActive"><Icon name="format" /> <span class="lbl">Format</span></button>
                <button v-if="!nonSql" class="btn btn-ghost ai-btn" title="Generate SQL with AI" data-tip="Writes SQL into the editor. You decide whether to run it." @click="openAi('generate')"><Icon name="bolt" /> <span class="lbl">AI</span></button>
                <button v-if="!nonSql" class="btn btn-ghost ai-btn" :disabled="!active.query.trim()" title="Investigate this query" data-tip="AI explains why it is slow. Read-only." @click="tabsStore.openInvestigations(active.connectionId, { type: 'query', sql: active.query })"><Icon name="target" /> <span class="lbl">Investigate</span></button>
                <button class="btn btn-ghost ai-btn" title="Chat with your data" data-tip="Opens the AI side panel. It can only read." @click="ui.openChatDock()"><Icon name="sparkles" /> <span class="lbl">Chat</span></button>
              </div>
              <button class="btn btn-ghost more" title="More query actions" aria-haspopup="menu" @click="openQueryMenu"><Icon name="more" /></button>
              <div class="spacer" />
              <div class="tb-group">
                <BookmarksMenu
                  v-if="!nonSql"
                  :conn-id="active.connectionId"
                  :current-sql="active.query"
                  @load="(sql) => { if (active) active.query = sql }"
                />
                <button
                  class="btn btn-ghost"
                  :class="{ 'is-saved': activeSaved }"
                  :disabled="!active.query.trim()"
                  @click="openSaveSnippet"
                  :title="activeSaved ? `Saved as “${activeSaved.name}”` : 'Save query'"
                  data-tip="Keeps this query under Saved Queries."
                ><Icon name="star" /> <span class="lbl">{{ activeSaved ? 'Saved' : 'Save' }}</span></button>
                <button v-if="canResultToTable" class="btn btn-ghost tb-icon fold" title="Save as new table" data-tip="Asks for a name, then creates a table from this result." @click="toTableOpen = true"><Icon name="tableExport" /></button>
                <button class="btn btn-ghost" title="Export" data-tip="Choose a format and file for these results." :disabled="!active.result" @click="exportOpen = true"><Icon name="download" /> <span class="lbl">Export</span></button>
              </div>
            </div>
            <div class="loading-bar" :data-busy="active.running || undefined" :class="{ active: active.running }" />
            <div class="editor-host">
              <SqlEditor
                v-model="active.query"
                :label="isMongo || isInflux ? 'Query editor' : 'SQL editor'"
                :schema="ws.schemas[active.connectionId]"
                :snippets="nonSql ? [] : tabsStore.savedSnippets"
                :placeholder="isMongo ? 'db.collection.find({ })' : isInflux ? 'from(bucket: …) |> range(start: -1h)' : 'SELECT * FROM …'"
                @run="(sql) => runActive(active!, sql)"
              />
            </div>
            <div v-if="activeLints.length" class="lints" :class="{ open: lintsOpen }">
              <button class="lint-bar" :aria-expanded="lintsOpen" @click="lintsOpen = !lintsOpen">
                <span class="lint-ic" :class="lintWarnCount ? 'warn' : 'info'"><Icon :name="lintWarnCount ? 'warn' : 'info'" :size="13" /></span>
                <span class="lint-sum">{{ activeLints.length }} SQL suggestion{{ activeLints.length === 1 ? '' : 's' }}</span>
                <span class="lint-caret"><Icon :name="lintsOpen ? 'chevronUp' : 'chevronDown'" :size="12" /></span>
              </button>
              <div v-if="lintsOpen" class="lint-list">
                <div v-for="l in activeLints" :key="l.rule" class="lint" :class="l.severity">
                  <span class="ldot" :class="l.severity" />
                  {{ l.message }}
                </div>
              </div>
            </div>
            <div class="results">
              <div v-if="active.error" class="run-error" role="alert">
                <div class="run-error-head">
                  <span class="run-error-msg">{{ active.error }}</span>
                  <button v-if="!nonSql" class="btn btn-ghost ai-btn fix-btn" title="Ask AI to fix this query" @click="openAi('fix')"><Icon name="sparkles" :size="13" /> Fix with AI</button>
                </div>
              </div>
              <!-- One sub-tab per result set when a script returns several -->
              <div v-if="(active.results?.length ?? 0) > 1" class="result-tabs">
                <button
                  v-for="(r, i) in active.results"
                  :key="i"
                  class="rt"
                  :class="{ on: active.resultIndex === i }"
                  @click="tabsStore.selectResult(active!, i)"
                >{{ resultLabel(r, i) }}</button>
              </div>
              <template v-if="active.result">
                <!-- Instant Visualization: chart any result with one click -->
                <div v-if="canChart(active.result)" class="result-view">
                  <div class="rv-toggle">
                    <button :class="{ on: qResultView === 'table' }" :aria-pressed="qResultView === 'table'" @click="qResultView = 'table'"><Icon name="table" :size="13" /> Table</button>
                    <button :class="{ on: qResultView === 'chart' }" :aria-pressed="qResultView === 'chart'" @click="showChartView"><Icon name="chart" :size="13" /> Chart</button>
                  </div>
                  <div v-if="qResultView === 'chart'" class="rv-types">
                    <button v-for="t in (['bar','line','area','pie'] as ChartType[])" :key="t" :class="{ on: qChartType === t }" @click="qChartType = t">{{ t }}</button>
                  </div>
                </div>
                <div v-if="qResultView === 'chart' && canChart(active.result)" class="instant-chart">
                  <ChartRender :type="qChartType" :result="active.result" instant />
                </div>
                <div v-else class="grid-host">
                  <ResultsGrid :result="active.result" @row-context="(r, e, c) => onRowContext(active!, r, e, c)" @view-cell="(r, c) => openCellViewer(active!, r, c)" />
                </div>
              </template>
            </div>
          </div>

          <!-- Table tab -->
          <div v-else-if="active.kind === 'table'" class="table-pane">
            <div class="toolbar">
              <div class="view-toggle">
                <button title="Data" data-tip="Rows in this table." :class="{ on: active.viewMode === 'data' }" :aria-pressed="active.viewMode === 'data'" @click="tabsStore.setViewMode(active, 'data')">Data</button>
                <button title="Structure" data-tip="Columns, keys and indexes." :class="{ on: active.viewMode === 'structure' }" :aria-pressed="active.viewMode === 'structure'" @click="tabsStore.setViewMode(active, 'structure')">Structure</button>
              </div>
              <span class="tb-sep" />
              <template v-if="active.viewMode === 'data'">
                <div class="tb-group">
                  <div class="pager">
                    <button
                      class="pg-btn"
                      :disabled="active.offset === 0 || active.running"
                      title="Previous page"
                      @click="tabsStore.prevPage(active)"
                    ><Icon name="chevronLeft" :size="15" /></button>
                    <span class="pg-info">{{ pageInfo(active) }}</span>
                    <button
                      class="pg-btn"
                      :disabled="active.running || (active.result && active.result.rows.length < active.pageSize) || false"
                      title="Next page"
                      @click="tabsStore.nextPage(active)"
                    ><Icon name="chevronRight" :size="15" /></button>
                  </div>
                  <select class="select sm fold-late" :value="active.pageSize" aria-label="Rows per page" title="Rows per page" @change="tabsStore.setPageSize(active, Number(($event.target as HTMLSelectElement).value))">
                    <option :value="100">100</option>
                    <option :value="200">200</option>
                    <option :value="500">500</option>
                    <option :value="1000">1000</option>
                  </select>
                  <button class="btn btn-ghost tb-icon fold-late" @click="tabsStore.reloadTable(active)" title="Reload rows (⌘R)"><Icon name="refresh" /></button>
                </div>
                <div v-if="tabsStore.editsAllowed(active)" class="tb-group">
                  <button class="btn btn-ghost fold-late" title="Add row" data-tip="Adds an empty row as an unsaved change." @click="tabsStore.addInsertRow(active)"><Icon name="plus" /> <span class="lbl">Add row</span></button>
                  <button
                    class="btn btn-ghost fold"
                    :disabled="active.selection.length === 0"
                    title="Bulk edit" data-tip="Sets one column across the selected rows. Not saved until you press Save."
                    @click="bulkOpen = true"
                  ><Icon name="pencil" /> <span class="lbl">Bulk edit<span v-if="active.selection.length"> ({{ active.selection.length }})</span></span></button>
                  <button
                    class="btn btn-ghost fold"
                    :disabled="active.selection.length === 0"
                    aria-haspopup="menu"
                    title="Generate SQL" data-tip="Opens INSERT or UPDATE statements for the selected rows in a new tab. Nothing runs."
                    @click="openGenerateSqlMenu"
                  ><Icon name="code" /> <span class="lbl">Generate SQL</span></button>
                </div>
                <button class="btn btn-ghost more" title="More table actions" aria-haspopup="menu" @click="openTableMenu"><Icon name="more" /></button>
                <div class="spacer" />
                <div class="tb-group fold">
                  <button class="btn btn-ghost tb-icon" :disabled="!canResultToTable" title="Save as new table" data-tip="Asks for a name, then creates a table from these rows." @click="toTableOpen = true"><Icon name="tableExport" /></button>
                  <button class="btn btn-ghost" :disabled="!active.result" title="Export" data-tip="Choose a format and file for these rows." @click="exportOpen = true"><Icon name="download" /> <span class="lbl">Export</span></button>
                </div>
                <div v-if="tabsStore.editsAllowed(active)" class="tb-group pinned">
                  <span class="dirty-info" :class="{ idle: !tabsStore.dirtyCount(active) }">{{ tabsStore.dirtyCount(active) }} unsaved</span>
                  <button class="btn btn-ghost discard" title="Discard changes" data-tip="Drops every unsaved change in this tab." :disabled="!tabsStore.dirtyCount(active)" @click="tabsStore.discardEdits(active)">Discard</button>
                  <button class="btn btn-primary" title="Save changes (⌘S)" data-tip="Writes your unsaved changes to the database." :disabled="!tabsStore.dirtyCount(active) || active.running" @click="tabsStore.commit(active)">Save <span class="save-key">⌘S</span></button>
                </div>
              </template>
              <template v-else>
                <button class="btn btn-ghost" @click="tabsStore.loadStructure(active)" title="Refresh"><Icon name="refresh" /> Reload</button>
                <div class="spacer" />
                <span v-if="active.running" class="status-mini">Working…</span>
              </template>
            </div>
            <div class="loading-bar" :data-busy="active.running || undefined" :class="{ active: active.running }" />

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
            <div class="data-head">
              <div v-if="active.table && ws.tableNote(activeConn.id, active.table.name)" class="table-note">
                <Icon name="note" :size="13" />
                <span class="table-note-text">{{ ws.tableNote(activeConn.id, active.table.name) }}</span>
                <button class="table-note-edit" title="Edit note" @click="noteTarget = active.table">Edit</button>
              </div>
              <FilterBar
                :columns="active.result?.columns ?? []"
                :filters="active.filters"
                @apply="(f) => onApplyFilters(active!, f)"
              />
            </div>

            <div class="table-body">
              <div class="grid-host">
                <div v-if="active.error" class="run-error" role="alert">{{ active.error }}</div>
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
                  :fk-columns="activeFkColumns"
                  @fk-navigate="onFkNavigate"
                  @select-row="(r) => onSelectRow(active!, r)"
                  @toggle-select="(r) => tabsStore.toggleRowSelection(active!, r)"
                  @toggle-select-all="tabsStore.toggleSelectAll(active!)"
                  @sort="(c) => tabsStore.toggleSort(active!, c)"
                  @edit-cell="(r, col, v) => tabsStore.editCell(active!, r, col, v)"
                  @edit-insert="(i, col, v) => tabsStore.editInsert(active!, i, col, v)"
                  @remove-insert="(i) => tabsStore.removeInsert(active!, i)"
                  @row-context="(r, e, c) => onRowContext(active!, r, e, c)"
                @view-cell="(r, c) => openCellViewer(active!, r, c)"
                @header-context="(col, e) => onHeaderContext(active!, col, e)"
                />
              </div>
              <div
                v-if="active.selectedRow !== null && active.result"
                class="resizer detail-resizer"
                title="Drag or use the arrow keys to resize"
                role="separator"
                tabindex="0"
                aria-orientation="vertical"
                aria-label="Row details width"
                aria-valuemin="240"
                aria-valuemax="640"
                :aria-valuenow="ui.detailWidth"
                @keydown.left.prevent="ui.setDetailWidth(ui.detailWidth + 16)"
                @keydown.right.prevent="ui.setDetailWidth(ui.detailWidth - 16)"
                @mousedown="startResize('detail', $event)"
              />
              <RowDetailPanel
                v-if="active.selectedRow !== null && active.result"
                :style="{ width: ui.detailWidth + 'px' }"
                :columns="active.result.columns"
                :row="active.result.rows[active.selectedRow]"
                :row-index="active.selectedRow"
                :edits="active.edits[active.selectedRow]"
                :primary-keys="active.primaryKeys"
                :editable="tabsStore.editsAllowed(active)"
                :dirty-count="tabsStore.dirtyCount(active)"
                :nullable="nullableMap(active)"
                @edit-cell="(r, col, v) => tabsStore.editCell(active!, r, col, v)"
                @set-null="(r, col) => tabsStore.setCellNull(active!, r, col)"
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
              <input class="input db-input" v-model="newDbName" aria-label="New database name" placeholder="New database name" @keydown.enter="createDatabase(active)" />
              <button class="btn btn-primary" :disabled="!newDbName.trim()" @click="createDatabase(active)">Create</button>
              <div class="spacer" />
              <button class="btn btn-ghost tb-icon" title="Refresh" @click="tabsStore.run(active)"><Icon name="refresh" /></button>
            </div>
            <div v-if="active.error" class="run-error" role="alert">{{ active.error }}</div>
            <div class="db-list">
              <div v-for="db in active.databases" :key="db" class="db-row">
                <span class="db-icon"><Icon name="database" :size="13" /></span>
                <button
                  v-if="activeConn?.serverMode"
                  class="db-name db-open"
                  title="Open this database"
                  @click="ws.connectAndOpen(serverDatabaseId(active.connectionId, db))"
                >{{ db }}</button>
                <span v-else class="db-name">{{ db }}</span>
                <button class="btn-ghost drop" :title="`Drop ${db}`" @click="dropDatabase(active, db)">Drop</button>
              </div>
            </div>
          </div>

          <!-- Users tab -->
          <div v-else-if="active.kind === 'users'" class="server-pane">
            <div class="toolbar">
              <strong>Users &amp; Roles</strong>
              <div class="spacer" />
              <span v-if="active.result" class="status-mini">{{ active.result.rowCount }} rows</span>
              <button class="btn btn-ghost tb-icon" title="Refresh" @click="tabsStore.run(active)"><Icon name="refresh" /></button>
            </div>
            <div class="results">
              <div v-if="active.error" class="run-error" role="alert">{{ active.error }}</div>
              <ResultsGrid v-else :result="active.result" />
            </div>
          </div>

          <!-- Processes tab -->
          <div v-else-if="active.kind === 'processes'" class="server-pane">
            <div class="toolbar">
              <strong>Process list</strong>
              <div class="spacer" />
              <span v-if="active.result" class="status-mini">{{ active.result.rowCount }} active</span>
              <button class="btn btn-ghost tb-icon" title="Refresh" @click="tabsStore.run(active)"><Icon name="refresh" /></button>
            </div>
            <div class="results">
              <div v-if="active.error" class="run-error" role="alert">{{ active.error }}</div>
              <ResultsGrid v-else :result="active.result" action-label="Kill" @action="(row) => killProcess(active!, row)" />
            </div>
          </div>

          <!-- Query history tab -->
          <div v-else-if="active.kind === 'history'" class="server-pane">
            <div class="toolbar">
              <strong>Query History</strong>
              <div class="spacer" />
              <span v-if="histTimes.length" class="status-mini">avg {{ histAvgMs }} ms · slowest {{ Math.round(histMaxMs) }} ms</span>
              <span class="status-mini">{{ active.entries?.length || 0 }} entries</span>
              <button class="btn btn-ghost tb-icon" title="Refresh" @click="tabsStore.run(active)"><Icon name="refresh" /></button>
              <button class="btn btn-ghost btn-danger" @click="tabsStore.clearHistory(active)">Clear</button>
            </div>
            <div class="history-list" data-rows>
              <div
                v-for="h in active.entries"
                :key="h.id"
                v-row
                role="button"
                class="history-item"
                :class="{ failed: !!h.error }"
                @click="useHistoryEntry(h.sql)"
                title="Click to open in a new query tab"
              >
                <pre class="history-sql">{{ h.sql }}</pre>
                <div class="history-meta">
                  <span class="hist-when">{{ relTime(h.ranAt) }}</span>
                  <span v-if="h.error" class="err">error</span>
                  <template v-else-if="h.rowCount !== undefined">
                    <span class="hist-rows">{{ h.rowCount }} rows</span>
                    <span class="dur-meter"><i class="dur-fill" :class="durClass(h.durationMs)" :style="{ width: durPct(h.durationMs) + '%' }" /></span>
                    <span class="dur-ms" :class="durClass(h.durationMs)">{{ Math.round(h.durationMs || 0) }} ms</span>
                  </template>
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
              <button class="btn btn-ghost tb-icon" title="Refresh" @click="tabsStore.run(active)"><Icon name="refresh" /></button>
            </div>
            <div class="history-list" role="list" data-rows>
              <div
                v-for="s in active.snippets"
                :key="s.id"
                v-row
                role="listitem"
                class="history-item snippet"
                @click="useSnippet(s)"
                title="Click to open in a new query tab"
              >
                <div class="snippet-head">
                  <span class="snippet-name">{{ s.name }}</span>
                  <span data-row-actions><button class="btn-ghost drop" :title="`Delete ${s.name}`" @click.stop="tabsStore.deleteSnippet(active!, s.id)"><Icon name="x" :size="12" /></button></span>
                </div>
                <pre class="history-sql">{{ s.sql }}</pre>
              </div>
              <div v-if="!active.snippets || active.snippets.length === 0" class="no-tables">
                No saved queries yet. Write a query and press Save.
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

          <!-- Chat with data tab -->
          <div v-else-if="active.kind === 'chat'" class="chat-pane">
            <ChatPanel :tab="active" />
          </div>

          <!-- Record explorer tab (click-through relationships) -->
          <div v-else-if="active.kind === 'explorer'" class="explorer-pane">
            <RecordExplorer :tab="active" />
          </div>

          <!-- Related records overview (aggregated relationships for one record) -->
          <div v-else-if="active.kind === 'related'" class="explorer-pane">
            <RelatedRecords :tab="active" />
          </div>

          <!-- Performance dashboard tab -->
          <div v-else-if="active.kind === 'performance'" class="explorer-pane">
            <PerformanceDashboard :conn-id="activeConn.id" :driver="activeConn.driver" />
          </div>

          <!-- AI Investigation Suite -->
          <div v-else-if="active.kind === 'investigations'" class="explorer-pane">
            <InvestigationsPanel :conn-id="activeConn.id" :init="active.investigateInit" />
          </div>

          <!-- Database documentation tab -->
          <div v-else-if="active.kind === 'docs'" class="explorer-pane">
            <DocsPanel :conn-id="activeConn.id" :conn-name="activeConn.name" :driver="activeConn.driver" />
          </div>

          <!-- Universal smart search tab -->
          <div v-else-if="active.kind === 'search'" class="explorer-pane">
            <SmartSearchPanel :conn-id="activeConn.id" :driver="activeConn.driver" />
          </div>

          <!-- Analytics module (dashboards / charts / datasets) -->
          <div v-else-if="active.kind === 'analytics'" class="explorer-pane">
            <AnalyticsPanel :conn-id="activeConn.id" :driver="activeConn.driver" />
          </div>

          <!-- Schema diff tab -->
          <div v-else-if="active.kind === 'schemaDiff'" class="server-pane">
            <SchemaDiffPanel
              :conn-id="activeConn.id"
              :conn-name="activeConn.name"
              :driver="activeConn.driver"
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

          <!-- Environment diff tab -->
          <div v-else-if="active.kind === 'envDiff'" class="server-pane">
            <EnvDiffPanel
              :conn-id="activeConn.id"
              :conn-name="activeConn.name"
              :candidates="otherConnections"
            />
          </div>

          <div v-else-if="active.kind === 'redisQueues'" class="explorer-pane">
            <RedisQueuePanel :conn-id="activeConn.id" />
          </div>

          <!-- Visual Query Builder tab -->
          <div v-else-if="active.kind === 'visualQuery'" class="explorer-pane">
            <VisualQueryBuilder :conn-id="activeConn.id" />
          </div>
        </div>
      </div>

      <!-- Slim status bar: one calm home for connection + result status, so the
           toolbars no longer have to carry it. -->
      <footer class="statusbar">
        <span class="state" :class="ws.connStates[activeConn.id] || 'disconnected'" />
        <span class="sb-name">{{ activeConn.name }}</span>
        <span class="sb-dim">{{ activeConn.driver }}<template v-if="activeConn.database"> · {{ activeConn.database }}</template></span>
        <span v-if="readOnly" class="sb-tag ro">Read-only</span>
        <span v-else-if="writeUnlocked" class="sb-tag wr">Writable {{ unlockCountdown }}</span>
        <span v-if="!nonSql && ws.txn[activeConn.id]" class="sb-tag tx">Transaction open</span>
        <div class="sb-spacer" />
        <span v-if="active && active.running" class="sb-stat" role="status">Working…</span>
        <span v-else-if="active && active.result && !active.error" class="sb-stat" role="status">
          {{ active.result.rowCount }} rows · {{ Math.round(active.result.durationMs) }} ms
        </span>
      </footer>

      <RedisKeyModal
        v-if="redisKeyTarget != null"
        :conn-id="activeConn.id"
        :redis-key="redisKeyTarget"
        @close="redisKeyTarget = null"
      />
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
      <DropAllObjectsModal
        v-if="ui.dropAllOpen"
        :conn-id="activeConn.id"
        @close="ui.dropAllOpen = false"
        @done="onDroppedAll(activeConn.id)"
      />
      <ImportModal
        v-if="ui.importOpen"
        :conn-id="activeConn.id"
        :tables="ws.tables"
        @close="ui.importOpen = false"
        @done="ws.refreshTables(activeConn.id)"
      />
      <TransferModal
        v-if="ui.transferOpen"
        :conn-id="activeConn.id"
        :tables="ws.tables"
        @close="ui.transferOpen = false"
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
      <TruncateTablesModal
        v-if="truncateTargets"
        :tables="truncateTargets"
        :driver="activeConn.driver"
        @confirm="performTruncate"
        @close="truncateTargets = null"
      />
      <CellValueModal
        v-if="cellViewer"
        :value="cellViewer.value"
        :column="cellViewer.column"
        :editable="cellViewer.editable"
        @save="saveCellValue"
        @close="cellViewer = null"
      />
      <ColumnStatsModal
        v-if="statsTarget"
        :conn-id="activeConn.id"
        :driver="activeConn.driver"
        :table="statsTarget.table"
        :column="statsTarget.column"
        @close="statsTarget = null"
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
      <CodegenModal
        v-if="codegenTarget"
        :connection-id="activeConn.id"
        :driver="activeConn.driver"
        :language="codegenTarget.language"
        :tables="codegenTarget.tables"
        @close="codegenTarget = null"
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

      <PlanTreeModal
        v-if="planRoot"
        :root="planRoot"
        :current-cost="planCost"
        :baseline="planBaseline"
        :just-saved="planBaselineJustSaved"
        @update-baseline="updatePlanBaseline"
        @close="planRoot = null"
      />

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

      <SnapshotsModal
        v-if="ui.snapshotsOpen && activeConn"
        :conn-id="activeConn.id"
        :conn-name="activeConn.name"
        :driver="activeConn.driver"
        :read-only="readOnly"
        @restored="ws.refreshTables(activeConn.id)"
        @close="ui.snapshotsOpen = false"
      />

      <RowHistoryModal
        v-if="rowHistoryTarget"
        :conn-id="rowHistoryTarget.connId"
        :table="rowHistoryTarget.table"
        :pk="rowHistoryTarget.pk"
        :label="rowHistoryTarget.label"
        :can-revert="!!active && tabsStore.editsAllowed(active)"
        @revert="revertRow"
        @close="rowHistoryTarget = null"
      />

      <CloneSqliteModal
        v-if="ui.cloneSqliteOpen && activeConn"
        :conn-id="activeConn.id"
        :conn-name="activeConn.name"
        :driver="activeConn.driver"
        @close="ui.cloneSqliteOpen = false"
      />

      <RecoverDeletedModal
        v-if="ui.recoverOpen && activeConn"
        :conn-id="activeConn.id"
        :driver="activeConn.driver"
        :read-only="readOnly"
        @changed="(t) => { if (active?.kind === 'table' && active.table?.name === t) tabsStore.reloadTable(active) }"
        @close="ui.recoverOpen = false"
      />

      <TableNoteModal
        v-if="noteTarget && activeConn"
        :table="noteTarget.name"
        :initial="ws.tableNote(activeConn.id, noteTarget.name)"
        @save="saveNote"
        @close="noteTarget = null"
      />

      <!-- Slide-out AI chat dock — usable without a query tab open. -->
      <transition name="dock">
        <aside v-if="ui.chatDockOpen && dockChat" class="chat-dock">
          <div class="chat-dock-head">
            <span class="chat-dock-title"><Icon name="sparkles" /> Chat with your data</span>
            <button class="icon-btn" title="Close chat" @click="ui.chatDockOpen = false"><Icon name="x" /></button>
          </div>
          <ChatPanel :tab="dockChat" />
        </aside>
      </transition>
    </template>
  </main>
</template>

<style scoped>
.main {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
  overflow: hidden;
}
/* Slide-out AI chat dock */
.chat-dock {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 420px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-left: 1px solid var(--border-strong);
  box-shadow: var(--shadow-pop);
  z-index: 40;
}
.chat-dock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 44px;
  flex: none;
  padding: 0 10px 0 16px;
  border-bottom: 1px solid var(--border);
}
.chat-dock-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text);
}
.chat-dock :deep(.chat) {
  flex: 1;
  min-height: 0;
  height: auto;
}
.dock-enter-active,
.dock-leave-active {
  transition: transform 0.22s ease, opacity 0.22s ease;
}
.dock-enter-from,
.dock-leave-to {
  transform: translateX(100%);
  opacity: 0.4;
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
  container: topbar / inline-size;
}
.topbar.inset {
  padding-left: 78px; /* clear macOS traffic lights when sidebar is collapsed */
}
.topbar .icon-btn,
.topbar .btn {
  -webkit-app-region: no-drag;
  flex-shrink: 0;
}
.topbar .dot,
.topbar .state {
  flex-shrink: 0;
}
.more {
  display: none;
}
.bar-sep {
  flex: none;
  width: 1px;
  height: 18px;
  background: var(--border-strong);
}
@container topbar (max-width: 1120px) {
  .topbar .meta {
    display: none;
  }
  .topbar .btn .lbl {
    display: none;
  }
  .topbar .btn {
    padding-inline: 10px;
  }
}
@container topbar (max-width: 990px) {
  .topbar .fold,
  .topbar .meta {
    display: none;
  }
  .topbar .more {
    display: inline-flex;
  }
}
@container topbar (max-width: 470px) {
  .topbar .palette-btn,
  .topbar .theme-btn,
  .topbar .lbl-keep {
    display: none;
  }
}
.icon-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-md);
}
.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.icon-btn.sm {
  width: 24px;
  height: 24px;
  font-size: var(--fs-base);
}
.palette-btn {
  font-size: var(--fs-xs);
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
/* Which database you are about to write to must never be squeezed out. */
.conn-name {
  font-size: var(--fs-base);
  font-weight: 600;
  flex: 0 1 auto;
  min-width: 72px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-size: var(--fs-xs);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  padding: 2px 9px;
  border-radius: 999px;
}
.ro-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-xs);
  font-weight: 700;
  color: var(--warn-text);
  background: var(--warn-soft);
  border: 1px solid var(--warn-line);
  padding: 2px 8px;
  border-radius: 999px;
  -webkit-app-region: no-drag;
}
.ro-badge.locked:hover {
  background: var(--warn-line);
}
.ro-badge.unlocked {
  color: var(--ok-text);
  background: var(--ok-soft);
  border-color: var(--ok-line);
  font-variant-numeric: tabular-nums;
}
.ro-badge.unlocked:hover {
  background: var(--ok-line);
}
.txn-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-xs);
  font-weight: 700;
  color: var(--warn-text);
  -webkit-app-region: no-drag;
}
.tx-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warn);
  animation: ddpulse 2s ease-in-out infinite;
}
.txn-commit {
  color: var(--ok-text);
}
.txn-rollback {
  color: var(--danger-text);
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
    radial-gradient(ellipse 55% 45% at 50% 42%, var(--accent-tint), transparent 70%),
    radial-gradient(ellipse 85% 70% at 50% 50%, var(--accent-tint), transparent 72%);
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
  background: radial-gradient(circle, var(--accent-glow), var(--accent-soft) 55%, transparent 70%);
  filter: blur(10px);
}
.welcome-logo {
  width: 92px;
  height: 92px;
  position: relative;
  filter: drop-shadow(0 16px 40px var(--accent-glow)) drop-shadow(0 8px 22px var(--shadow-color));
}
.welcome-card h1 {
  font-size: var(--fs-2xl);
  font-weight: 700;
  letter-spacing: -0.4px;
  color: var(--text);
  margin-bottom: 10px;
}
.welcome-card p {
  font-size: var(--fs-base);
}
.welcome-card .sub {
  font-size: var(--fs-sm);
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
.state.idle {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--ok);
}
.spacer {
  flex: 1;
}
.prod-banner {
  flex-shrink: 0;
  background: var(--danger);
  color: var(--on-danger);
  font-weight: 700;
  font-size: var(--fs-sm);
  letter-spacing: 0.03em;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 12px;
}
.conn-error {
  background: var(--danger-soft);
  color: var(--danger-text);
  padding: 7px 14px;
  font-size: var(--fs-sm);
  font-family: var(--mono);
}
/* Banners (production warning, connection errors) slide down into place. */
.drop-enter-active,
.drop-leave-active {
  transition: opacity var(--dur-2) ease, transform var(--dur-2) var(--ease-out);
}
.drop-enter-from,
.drop-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.work {
  flex: 1;
  display: flex;
  overflow: hidden;
}
/* Slim bottom status bar */
.statusbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  height: 26px;
  padding: 0 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
  font-size: var(--fs-xs);
  color: var(--text-dim);
  -webkit-app-region: no-drag;
}
.sb-name {
  font-weight: 600;
  color: var(--text);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-dim {
  color: var(--text-faint);
}
.sb-spacer {
  flex: 1;
}
.sb-stat {
  font-family: var(--mono);
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.sb-tag {
  font-size: var(--fs-xs);
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  white-space: nowrap;
}
.sb-tag.ro,
.sb-tag.tx {
  color: var(--warn-text);
  background: var(--warn-soft);
  border-color: var(--warn-line);
}
.sb-tag.wr {
  color: var(--ok-text);
  background: var(--ok-soft);
  border-color: var(--ok-line);
  font-variant-numeric: tabular-nums;
}
.tables {
  width: 210px;
  max-width: 36%;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  overflow: hidden;
}
/* Drag handles for resizable panels. */
.resizer {
  flex: none;
  width: 6px;
  cursor: col-resize;
  border-radius: 3px;
  -webkit-app-region: no-drag;
  transition: background 0.12s;
}
.resizer:hover,
.resizer:active {
  background: var(--accent-soft);
}
.detail-resizer {
  align-self: stretch;
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
  display: flex;
  align-items: center;
  justify-content: center;
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
.spin {
  animation: tables-spin 0.7s linear infinite;
}
@keyframes tables-spin {
  to {
    transform: rotate(360deg);
  }
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
  transition: background var(--dur-1);
}
.table-item:hover {
  background: var(--bg-hover);
}
.table-item.selected {
  background: var(--accent-soft);
}
.table-item.selected .tname {
  color: var(--accent-text);
}
.sel-hint {
  flex-shrink: 0;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.ticon {
  display: inline-flex;
  align-items: center;
  color: var(--accent-text);
}
.tname {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tnote {
  display: inline-flex;
  align-items: center;
  color: var(--text-faint);
  flex: none;
}
.table-item:hover .tnote {
  color: var(--accent-text);
}
.no-tables {
  color: var(--text-faint);
  padding: 10px;
  font-size: var(--fs-sm);
}

/* Tabs */
.tab-area {
  container: tabarea / inline-size;
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
  background: var(--bg-app);
}
.tab-list {
  display: flex;
  align-items: stretch;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
}
/* Keep the strip's own scrollbar slim so it doesn't crowd the tabs. */
.tab-list::-webkit-scrollbar {
  height: 4px;
}
/* New tabs rise in; when one closes, its neighbours slide over to fill the gap. */
.tabs-enter-active {
  transition: opacity var(--dur-2) ease, transform var(--dur-2) var(--ease-out);
}
.tabs-enter-from {
  opacity: 0;
  transform: translateY(7px);
}
.tabs-move {
  transition: transform var(--dur-2) var(--ease-out);
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
  border-color: var(--accent-ring);
}
.tab.on .tab-title {
  font-weight: 600;
}
.tab-kind {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}
/* Calmer tab dots: four semantic families (data · query · tools · admin)
   drawn from the analytics palette, instead of a full rainbow. Inactive tabs
   dim their dot so the active tab reads first. */
.tab:not(.on) .tab-kind {
  opacity: 0.5;
}
.tab-kind.table,
.tab-kind.diagram {
  background: var(--accent);
}
.tab-kind.query,
.tab-kind.snippets,
.tab-kind.history,
.tab-kind.visualQuery {
  background: var(--chart-2);
}
.tab-kind.chat,
.tab-kind.explorer,
.tab-kind.search,
.tab-kind.performance,
.tab-kind.docs,
.tab-kind.redisQueues,
.tab-kind.envDiff,
.tab-kind.schemaDiff,
.tab-kind.dataDiff,
.tab-kind.visualQuery {
  background: var(--chart-4);
}
.tab-kind.databases,
.tab-kind.users,
.tab-kind.processes {
  background: var(--chart-3);
}
.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab-dirty {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warn);
}
.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  flex: none;
  width: 24px;
  height: 24px;
  margin: -4px -7px -4px -3px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}
/* Reveal the close affordance only on the hovered/active tab — less persistent
   clutter across a full strip of tabs. */
.tab:hover .tab-close,
.tab:focus-visible .tab-close,
.tab.on .tab-close {
  opacity: 1;
}
.tab-close:hover {
  background: var(--bg-active);
  color: var(--text);
}
.tab-add {
  flex: none;
  display: inline-flex;
  align-items: center;
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
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.editor-pane > .toolbar,
.editor-pane > .loading-bar,
.editor-pane > .lints {
  flex: none;
}
/* Editor and results split ~0.4 : 1, matching the prior grid, but robust to the
   always-present loading bar and the optional lints panel between them. */
.editor-pane > .editor-host {
  flex: 2 1 0;
  min-height: 110px;
}
.editor-pane > .results {
  flex: 5 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.table-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.table-pane > .toolbar,
.table-pane > .loading-bar,
.table-pane > .data-head {
  flex: none;
}
.table-pane > .table-body,
.table-pane > .structure {
  flex: 1;
  min-height: 0;
}
.table-note {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 7px 16px;
  background: var(--accent-soft);
  border-bottom: 1px solid var(--border-soft);
  font-size: var(--fs-sm);
  color: var(--text);
}
.table-note > :deep(.dd-icon) {
  color: var(--accent-text);
  flex: none;
}
.table-note-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.table-note-edit {
  flex: none;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  padding: 2px 8px;
  border-radius: 999px;
}
.table-note-edit:hover {
  background: var(--bg-hover);
  color: var(--text);
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
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-panel);
  box-shadow: var(--shadow-card);
}
.server-pane {
  flex: 1;
  display: grid;
  grid-template-rows: auto 1fr;
  overflow: hidden;
}
.chat-pane {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}
.explorer-pane {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}
.explorer-pane > * {
  flex: 1;
  min-width: 0;
}
.chat-pane > * {
  flex: 1;
  min-width: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  /* One fixed-height row that scrolls horizontally if it overflows — buttons
     never wrap to a second line, so toggling them never shifts the grid. */
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  min-height: 50px;
  gap: 7px 8px;
  padding: 9px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.toolbar::-webkit-scrollbar {
  height: 6px;
}
.toolbar::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}
.toolbar .tb-group,
.toolbar .pager,
.toolbar .btn,
.toolbar .select,
.toolbar .pg-btn {
  flex-shrink: 0;
}
/* As the panel narrows: labels collapse to icons, then secondary actions fold
   into the More menu. Save stays pinned to the right edge throughout; a scrollbar
   is the last resort. */
@container tabarea (max-width: 1290px) {
  .toolbar .hint,
  .table-pane .toolbar .lbl {
    display: none;
  }
  .table-pane .toolbar .btn:has(> .lbl) {
    padding-inline: 9px;
  }
}
@container tabarea (max-width: 1060px) {
  .toolbar :deep(.lbl) {
    display: none;
  }
  .toolbar :deep(.btn:has(> .lbl)) {
    padding-inline: 9px;
  }
}
@container tabarea (max-width: 700px) {
  .editor-pane .toolbar .fold {
    display: none;
  }
  .editor-pane .toolbar .more {
    display: inline-flex;
  }
}
@container tabarea (max-width: 1000px) {
  .table-pane .toolbar .fold,
  .toolbar .dirty-info,
  .toolbar .discard:disabled,
  .toolbar .tb-sep {
    display: none;
  }
  .table-pane .toolbar .more {
    display: inline-flex;
  }
}
@container tabarea (max-width: 740px) {
  .toolbar .fold-late,
  .toolbar .save-key {
    display: none;
  }
}
@container tabarea (max-width: 480px) {
  .toolbar .pg-info,
  .toolbar .discard {
    display: none;
  }
  .toolbar {
    padding-inline: 8px;
  }
  .toolbar .view-toggle button {
    padding-inline: 8px;
  }
}
@container tabarea (max-width: 340px) {
  .toolbar .pager,
  .toolbar .tb-group:not(.pinned):has(> .bm) {
    display: none;
  }
  .toolbar {
    gap: 4px;
  }
  .toolbar .view-toggle button {
    padding-inline: 5px;
  }
  .toolbar .btn,
  .toolbar :deep(.btn) {
    padding-inline: 7px;
  }
}
.toolbar .pinned {
  position: sticky;
  right: 0;
  padding-left: 8px;
  background: var(--bg-panel);
}
/* Keep controls full-size rather than squishing them. */
.toolbar > * {
  flex-shrink: 0;
}
.toolbar .hint {
  color: var(--text-faint);
  font-size: var(--fs-xs);
}
/* Thin indeterminate progress under the toolbar while a query/table is busy. */
/* Always present as a 2px track (transparent when idle) so toggling the
   loading state never adds/removes layout — only the animation appears. */
.loading-bar {
  position: relative;
  flex: none;
  height: 2px;
  overflow: hidden;
  background: transparent;
}
.loading-bar.active {
  background: var(--accent-soft);
}
.loading-bar.active::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 22%;
  background: var(--accent);
  border-radius: 2px;
  animation: ddsweep 1.1s ease-in-out infinite;
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
  font-size: var(--fs-sm);
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
  color: var(--accent-text);
  box-shadow: 0 1px 3px var(--shadow-color);
}
.tb-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 2px;
}
/* A cluster of related controls that stays intact and wraps as one unit, so a
   narrow toolbar breaks between groups instead of scattering single buttons. */
.tb-group {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
/* Segmented pager — three controls read as one compact object. */
.pager {
  display: inline-flex;
  align-items: center;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  -webkit-app-region: no-drag;
}
.pg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: var(--fs-md);
  line-height: 1;
  color: var(--text-dim);
  border-radius: 999px;
}
.pg-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--bg-hover);
}
.pg-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.pg-info {
  font-family: var(--mono);
  font-size: var(--fs-sm);
  color: var(--text-dim);
  padding: 0 9px;
  min-width: 58px;
  text-align: center;
}
/* Icon-only ghost buttons in toolbars: square, no text padding. */
.tb-icon {
  padding: 5px 9px;
  font-size: var(--fs-md);
}
.status-mini {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 12px;
}
.select.sm {
  padding: 4px 6px;
  font-size: var(--fs-sm);
}
.db-input {
  width: 240px;
}
.status-mini {
  color: var(--text-dim);
  font-size: var(--fs-xs);
  font-family: var(--mono);
}
.dirty-info {
  color: var(--warn-text);
  font-size: var(--fs-sm);
  white-space: nowrap;
}
/* Keep its width reserved when there are no edits, so Save/Discard don't slide. */
.dirty-info.idle {
  visibility: hidden;
}
.btn.is-saved {
  color: var(--accent-text);
}
.btn.is-saved .dd-icon {
  fill: currentColor;
}
.cancel-btn {
  color: var(--danger-text);
}
.cancel-btn:hover {
  background: var(--danger-soft);
}
.ai-btn {
  color: var(--accent-text);
}
.ai-btn:hover {
  background: var(--accent-soft);
}
.ai-btn.on {
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
.lints {
  flex: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.lint-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 14px;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
.lint-bar:hover {
  background: var(--bg-hover);
}
.lint-ic.warn {
  color: var(--warn-text);
}
.lint-ic.info {
  color: var(--text-faint);
}
.lint-sum {
  font-weight: 600;
  color: var(--text);
}
.lint-caret {
  margin-left: auto;
  color: var(--text-faint);
  font-size: var(--fs-xs);
}
.lint-list {
  padding: 2px 14px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.lint {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
.ldot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  transform: translateY(-1px);
}
.ldot.warn {
  background: var(--warn);
}
.ldot.info {
  background: var(--text-faint);
}
.results {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.grid-host,
.instant-chart {
  flex: 1;
  min-height: 0;
}
.result-tabs {
  flex: none;
  display: flex;
  gap: 2px;
  align-items: center;
  padding: 4px 8px 0;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
}
.result-tabs .rt {
  flex: none;
  font-size: var(--fs-sm);
  padding: 4px 11px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  color: var(--text-dim);
  white-space: nowrap;
}
.result-tabs .rt:hover {
  color: var(--text);
}
.result-tabs .rt.on {
  background: var(--bg-elevated);
  border-color: var(--border);
  color: var(--accent-text);
  font-weight: 600;
}
.instant-chart {
  padding: 8px 10px 10px;
}
.result-view {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.rv-toggle,
.rv-types {
  display: inline-flex;
  gap: 2px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px;
}
.rv-toggle button,
.rv-types button {
  font-size: var(--fs-sm);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 3px 9px;
  border-radius: calc(var(--radius-sm) - 2px);
  color: var(--text-dim);
  text-transform: capitalize;
}
.rv-toggle button:hover,
.rv-types button:hover {
  color: var(--text);
}
.rv-toggle button.on,
.rv-types button.on {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 600;
}
.run-error {
  padding: 14px;
  color: var(--danger-text);
  font-family: var(--mono);
  font-size: var(--fs-sm);
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
  font-size: var(--fs-sm);
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 60px;
  overflow: hidden;
  margin: 0;
}
.history-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 5px;
  font-size: var(--fs-xs);
  color: var(--text-faint);
  font-family: var(--mono);
}
.history-meta .err {
  color: var(--danger-text);
}
.hist-when {
  min-width: 64px;
}
.hist-rows {
  min-width: 60px;
}
/* Relative execution-time bar, coloured fast → slow. */
.dur-meter {
  flex: 1;
  max-width: 160px;
  height: 5px;
  border-radius: 999px;
  background: var(--bg-elevated);
  overflow: hidden;
}
.dur-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--text-faint);
}
.dur-fill.fast {
  background: var(--ok);
}
.dur-fill.mid {
  background: var(--warn);
}
.dur-fill.slow {
  background: var(--danger);
}
.dur-ms {
  min-width: 54px;
  text-align: right;
}
.dur-ms.fast {
  color: var(--ok-text);
}
.dur-ms.mid {
  color: var(--warn-text);
}
.dur-ms.slow {
  color: var(--danger-text);
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
  color: var(--danger-text);
  width: 24px;
  height: 24px;
  border-radius: 4px;
}
.snippet .drop:focus-visible {
  opacity: 1;
}
.snippet .drop:hover {
  background: var(--danger-soft);
}
.btn-danger {
  color: var(--danger-text);
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
.db-row .db-icon {
  display: inline-flex;
  color: var(--text-faint);
}
.db-name {
  flex: 1;
  font-family: var(--mono);
}
.db-open {
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  color: var(--text);
  font-size: inherit;
  cursor: pointer;
}
.db-open:hover {
  color: var(--accent-text);
  text-decoration: underline;
}
.drop {
  color: var(--danger-text);
  font-size: var(--fs-xs);
  padding: 3px 9px;
  border-radius: 4px;
}
.drop:hover {
  background: var(--danger-soft);
}
</style>
