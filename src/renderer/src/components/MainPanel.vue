<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
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
import NamePrompt from './NamePrompt.vue'
import CreateTableModal from './CreateTableModal.vue'
import DropTablesModal from './DropTablesModal.vue'
import TruncateTablesModal from './TruncateTablesModal.vue'
import CellValueModal from './CellValueModal.vue'
import ColumnStatsModal from './ColumnStatsModal.vue'
import ContextMenu from './ContextMenu.vue'
import ErDiagram from './ErDiagram.vue'
import ChatPanel from './ChatPanel.vue'
import RecordExplorer from './RecordExplorer.vue'
import RelatedRecords from './RelatedRecords.vue'
import PerformanceDashboard from './PerformanceDashboard.vue'
import DocsPanel from './DocsPanel.vue'
import SmartSearchPanel from './SmartSearchPanel.vue'
import AnalyticsPanel from './AnalyticsPanel.vue'
import ChartRender from './ChartRender.vue'
import { canChart, autoDetect } from '../lib/chartOption'
import EnvDiffPanel from './EnvDiffPanel.vue'
import SchemaDiffPanel from './SchemaDiffPanel.vue'
import DataDiffPanel from './DataDiffPanel.vue'
import RedisQueuePanel from './RedisQueuePanel.vue'
import RedisKeyModal from './RedisKeyModal.vue'
import VisualQueryBuilder from './VisualQueryBuilder.vue'
import DataGeneratorModal from './DataGeneratorModal.vue'
import AiAssistantModal from './AiAssistantModal.vue'
import QueryVarsModal from './QueryVarsModal.vue'
import PlanTreeModal from './PlanTreeModal.vue'
import BulkEditModal from './BulkEditModal.vue'
import DependenciesModal from './DependenciesModal.vue'
import TableSizesModal from './TableSizesModal.vue'
import ColumnSearchModal from './ColumnSearchModal.vue'
import SnapshotsModal from './SnapshotsModal.vue'
import TableNoteModal from './TableNoteModal.vue'
import type { ChartType, DropTableOptions, PlanNode, TruncateOptions } from '@shared/types'

type MenuItem = { label?: string; danger?: boolean; sep?: boolean; shortcut?: string; action?: () => void }
import { sqlDialect, type FilterOp, type FilterSpec, type Snippet, type TableInfo } from '@shared/types'
import { formatSql } from '../lib/sql'
import { lintSql } from '../lib/sqlLint'
import { rowToJson, rowToCsv, rowToInsert, rowsToInserts, rowsToUpdates } from '../lib/rowCopy'
import { canExportToTable, planResultTable } from '../lib/resultTable'
import logoUrl from '../assets/logo.png'

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
const saveSnippetOpen = ref(false)
const createTableOpen = ref(false)
const exportTableTarget = ref<TableInfo | null>(null)
const genTarget = ref<TableInfo | null>(null)
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
        { label: '🔍 View value', action: () => (redisKeyTarget.value = String(key)) },
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
          label: '🔎 Explore record',
          action: () =>
            tabsStore.openExplorer(tab.connectionId, {
              table: tableName,
              column: pkCol,
              value,
              label: `${tableName} #${String(value)}`
            })
        },
        {
          label: '🌐 Related records',
          action: () =>
            tabsStore.openRelated(tab.connectionId, {
              table: tableName,
              column: pkCol,
              value,
              label: `${tableName} #${String(value)}`
            })
        },
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
  }
  ctx.value = { x: e.clientX, y: e.clientY, items }
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

// Lazily load the FK graph whenever a table tab on this connection is shown.
watch(
  () => (active.value?.kind === 'table' ? active.value.connectionId : null),
  (cid) => {
    if (cid && !ws.erModels[cid]) void ws.loadErModel(cid).catch(() => {})
  },
  { immediate: true }
)

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
function unlockWrites(): void {
  const c = activeConn.value
  if (!c) return
  const msg = c.production
    ? `⚠ ${c.name} is a PRODUCTION connection. Allow writes for 15 minutes?`
    : `Allow writes to “${c.name}” for 15 minutes?`
  if (confirm(msg)) ws.unlockWrites(c.id, 15)
}
function relockWrites(): void {
  if (activeConn.value) ws.relockWrites(activeConn.value.id)
}
const isProduction = computed(() => !!activeConn.value?.production)
const explainable = computed(() =>
  ['postgres', 'mysql', 'sqlite'].includes(sqlDialect(activeConn.value?.driver ?? ''))
)
// Engines that can abort an in-flight query (SQLite runs synchronously, can't).
const cancellable = computed(
  () => !nonSql.value && ['postgres', 'mysql', 'mssql'].includes(sqlDialect(activeConn.value?.driver ?? ''))
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
  if (ws.activeConnectionId) await ws.disconnect(ws.activeConnectionId)
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
      <button class="icon-btn" title="Toggle sidebar (⌘B)" @click="ui.toggleSidebar()"><Icon name="menu" /></button>
      <template v-if="activeConn">
        <span class="dot" :style="{ background: activeConn.color || '#888f9c' }" />
        <strong class="conn-name">{{ activeConn.name }}</strong>
        <span class="meta">{{ activeConn.driver }}<template v-if="activeConn.database"> · {{ activeConn.database }}</template></span>
        <span class="state" :class="ws.connStates[activeConn.id] || 'disconnected'" />
        <button
          v-if="readOnly"
          class="ro-badge locked"
          title="Read-only (safe mode) — click to temporarily allow writes"
          @click="unlockWrites"
        ><Icon name="lock" :size="12" /> Read-only</button>
        <button
          v-else-if="writeUnlocked"
          class="ro-badge unlocked"
          title="Writes temporarily unlocked — click to re-lock now"
          @click="relockWrites"
        ><Icon name="unlock" :size="12" /> Writable {{ unlockCountdown }}</button>
      </template>
      <strong v-else class="brand-title">DataDock</strong>
      <div class="spacer drag" />
      <button class="icon-btn palette-btn" title="Command palette (⌘K)" @click="ui.openPalette()">⌘K</button>
      <button class="icon-btn" :title="ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'" @click="ui.toggleTheme()">
        <Icon :name="ui.theme === 'dark' ? 'sun' : 'moon'" />
      </button>
      <template v-if="activeConn">
        <template v-if="!nonSql && !readOnly">
          <template v-if="ws.txn[activeConn.id]">
            <span class="txn-badge" title="Open transaction — uncommitted"><span class="tx-dot" /> TX</span>
            <button class="btn btn-ghost txn-commit" @click="ws.commitTxn(activeConn.id)">Commit</button>
            <button class="btn btn-ghost txn-rollback" @click="ws.rollbackTxn(activeConn.id)">Rollback</button>
          </template>
          <button v-else class="btn btn-ghost" title="Begin transaction" @click="ws.beginTxn(activeConn.id)"><Icon name="swap" /> Begin Tx</button>
        </template>            <button
          class="btn btn-ghost ai-btn"
          :class="{ on: ui.chatDockOpen }"
          title="Chat with your data"
          @click="ui.toggleChatDock()"
        ><Icon name="sparkles" /> Chat</button>
        <button class="btn btn-ghost" title="Visual Query Builder" @click="tabsStore.openVisualQuery(activeConn.id)"><Icon name="diagram" /> Builder</button>
        <button class="btn btn-ghost" title="Analytics — charts & dashboards (⌘⇧A)" @click="tabsStore.openAnalytics(activeConn.id)"><Icon name="chart" /> Analytics</button>
        <button class="btn btn-ghost" @click="newQuery"><Icon name="plus" /> Query</button>
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
        <div class="tables" v-show="!ui.tablesCollapsed" :style="{ width: ui.tablesWidth + 'px' }">
          <div class="tables-head">
            <input class="input filter" v-model="tableFilter" placeholder="Filter tables…" />
            <button v-if="!nonSql && !readOnly" class="icon-btn sm" title="New table" @click="createTableOpen = true"><Icon name="plus" :size="14" /></button>
            <button class="icon-btn sm" title="Collapse list" @click="ui.toggleTables()"><Icon name="chevronLeft" :size="14" /></button>
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
          <div v-if="multiSelect" class="sel-hint">{{ selectedTables.length }} selected · ⌫ to delete</div>
        </div>
        <div
          v-show="!ui.tablesCollapsed"
          class="resizer"
          title="Drag to resize"
          @mousedown="startResize('tables', $event)"
        />
        <button v-if="ui.tablesCollapsed" class="tables-expand" title="Show tables" @click="ui.toggleTables()"><Icon name="chevronRight" :size="14" /></button>

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
              <button class="tab-close" @click.stop="tabsStore.closeTab(tab.id)"><Icon name="x" :size="12" /></button>
            </div>
            <button class="tab-add" @click="newQuery" title="New query"><Icon name="plus" :size="15" /></button>
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
                  title="Run all statements (⌘⇧↵). ⌘↵ runs the selection or the statement at the cursor."
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
              <div class="tb-group">
                <button v-if="explainable" class="btn btn-ghost" :disabled="!active.query.trim() || active.running" title="Show query plan (EXPLAIN)" @click="tabsStore.explain(active)"><Icon name="explain" /> Explain</button>
                <button v-if="visualExplainable" class="btn btn-ghost" :disabled="!active.query.trim() || active.running || planLoading" title="Visualize the query plan as a tree" @click="openPlan(active)"><Icon name="plan" /> {{ planLoading ? 'Plan…' : 'Plan' }}</button>
                <button v-if="!nonSql" class="btn btn-ghost" :disabled="!active.query.trim()" title="Format SQL (⌘⇧F)" @click="formatActive"><Icon name="format" /> Format</button>
                <button v-if="!nonSql" class="btn btn-ghost ai-btn" title="Generate SQL with AI" @click="openAi('generate')"><Icon name="sparkles" /> AI</button>
                <button class="btn btn-ghost ai-btn" title="Chat with your data" @click="ui.openChatDock()"><Icon name="sparkles" /> Chat</button>
              </div>
              <div class="spacer" />
              <div class="tb-group">
                <button
                  class="btn btn-ghost"
                  :class="{ 'is-saved': activeSaved }"
                  :disabled="!active.query.trim()"
                  @click="openSaveSnippet"
                  :title="activeSaved ? `Saved as “${activeSaved.name}”` : 'Save as snippet'"
                ><Icon name="star" /> {{ activeSaved ? 'Saved' : 'Save' }}</button>
                <button v-if="canResultToTable" class="btn btn-ghost tb-icon" title="Save this result as a new table" @click="toTableOpen = true"><Icon name="tableExport" /></button>
                <button class="btn btn-ghost" :disabled="!active.result" @click="exportOpen = true"><Icon name="download" /> Export</button>
              </div>
            </div>
            <div v-if="active.running" class="loading-bar" />
            <div class="editor-host">
              <SqlEditor
                v-model="active.query"
                :schema="ws.schemas[active.connectionId]"
                :placeholder="isMongo ? 'db.collection.find({ })' : isInflux ? 'from(bucket: …) |> range(start: -1h)' : 'SELECT * FROM …'"
                @run="(sql) => runActive(active!, sql)"
              />
            </div>
            <div v-if="activeLints.length" class="lints" :class="{ open: lintsOpen }">
              <button class="lint-bar" @click="lintsOpen = !lintsOpen">
                <span class="lint-ic" :class="lintWarnCount ? 'warn' : 'info'">{{ lintWarnCount ? '⚠' : 'ℹ' }}</span>
                <span class="lint-sum">{{ activeLints.length }} SQL suggestion{{ activeLints.length === 1 ? '' : 's' }}</span>
                <span class="lint-caret">{{ lintsOpen ? '▴' : '▾' }}</span>
              </button>
              <div v-if="lintsOpen" class="lint-list">
                <div v-for="l in activeLints" :key="l.rule" class="lint" :class="l.severity">
                  <span class="ldot" :class="l.severity" />
                  {{ l.message }}
                </div>
              </div>
            </div>
            <div class="results">
              <div v-if="active.error" class="run-error">
                <div class="run-error-head">
                  <span class="run-error-msg">{{ active.error }}</span>
                  <button v-if="!nonSql" class="btn btn-ghost ai-btn fix-btn" title="Ask AI to fix this query" @click="openAi('fix')">✨ Fix with AI</button>
                </div>
              </div>
              <template v-else>
                <!-- Instant Visualization: chart any result with one click -->
                <div v-if="canChart(active.result)" class="result-view">
                  <div class="rv-toggle">
                    <button :class="{ on: qResultView === 'table' }" @click="qResultView = 'table'">▦ Table</button>
                    <button :class="{ on: qResultView === 'chart' }" @click="showChartView">📊 Chart</button>
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
                <button :class="{ on: active.viewMode === 'data' }" @click="tabsStore.setViewMode(active, 'data')">Data</button>
                <button :class="{ on: active.viewMode === 'structure' }" @click="tabsStore.setViewMode(active, 'structure')">Structure</button>
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
                  <select class="select sm" :value="active.pageSize" title="Rows per page" @change="tabsStore.setPageSize(active, Number(($event.target as HTMLSelectElement).value))">
                    <option :value="100">100</option>
                    <option :value="200">200</option>
                    <option :value="500">500</option>
                    <option :value="1000">1000</option>
                  </select>
                  <button class="btn btn-ghost tb-icon" @click="tabsStore.reloadTable(active)" title="Refresh"><Icon name="refresh" /></button>
                </div>
                <div v-if="tabsStore.editsAllowed(active)" class="tb-group">
                  <button class="btn btn-ghost" @click="tabsStore.addInsertRow(active)"><Icon name="plus" /> Add row</button>
                  <button
                    v-if="active.selection.length > 0"
                    class="btn btn-ghost"
                    title="Set a column to one value across the selected rows"
                    @click="bulkOpen = true"
                  ><Icon name="pencil" /> Bulk edit ({{ active.selection.length }})</button>
                  <button
                    v-if="active.selection.length > 0"
                    class="btn btn-ghost"
                    title="Generate INSERT/UPDATE SQL from the selected rows"
                    @click="openGenerateSqlMenu"
                  ><Icon name="code" /> Generate SQL</button>
                </div>
                <div class="spacer" />
                <div class="tb-group">
                  <template v-if="tabsStore.dirtyCount(active) > 0">
                    <span class="dirty-info">{{ tabsStore.dirtyCount(active) }} unsaved</span>
                    <button class="btn btn-ghost" @click="tabsStore.discardEdits(active)">Discard</button>
                    <button class="btn btn-primary" :disabled="active.running" @click="tabsStore.commit(active)">Save ⌘S</button>
                  </template>
                  <button v-if="canResultToTable" class="btn btn-ghost tb-icon" title="Save this result as a new table" @click="toTableOpen = true"><Icon name="tableExport" /></button>
                  <button class="btn btn-ghost" :disabled="!active.result" @click="exportOpen = true"><Icon name="download" /> Export</button>
                </div>
              </template>
              <template v-else>
                <button class="btn btn-ghost" @click="tabsStore.loadStructure(active)" title="Refresh"><Icon name="refresh" /> Reload</button>
                <div class="spacer" />
                <span v-if="active.running" class="status-mini">Working…</span>
              </template>
            </div>
            <div v-if="active.running" class="loading-bar" />

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
                v-if="active.result"
                :columns="active.result.columns"
                :filters="active.filters"
                @apply="(f) => onApplyFilters(active!, f)"
              />
            </div>

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
                title="Drag to resize"
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
              <input class="input db-input" v-model="newDbName" placeholder="New database name" @keydown.enter="createDatabase(active)" />
              <button class="btn btn-primary" :disabled="!newDbName.trim()" @click="createDatabase(active)">Create</button>
              <div class="spacer" />
              <button class="btn btn-ghost tb-icon" title="Refresh" @click="tabsStore.run(active)"><Icon name="refresh" /></button>
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
              <button class="btn btn-ghost tb-icon" title="Refresh" @click="tabsStore.run(active)"><Icon name="refresh" /></button>
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
              <button class="btn btn-ghost tb-icon" title="Refresh" @click="tabsStore.run(active)"><Icon name="refresh" /></button>
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
              <button class="btn btn-ghost tb-icon" title="Refresh" @click="tabsStore.run(active)"><Icon name="refresh" /></button>
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
              <button class="btn btn-ghost tb-icon" title="Refresh" @click="tabsStore.run(active)"><Icon name="refresh" /></button>
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
        <span v-if="active && active.running" class="sb-stat">Working…</span>
        <span v-else-if="active && active.result && !active.error" class="sb-stat">
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

      <SnapshotsModal
        v-if="ui.snapshotsOpen && activeConn"
        :conn-id="activeConn.id"
        :conn-name="activeConn.name"
        :driver="activeConn.driver"
        :read-only="readOnly"
        @restored="ws.refreshTables(activeConn.id)"
        @close="ui.snapshotsOpen = false"
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
  box-shadow: -8px 0 28px rgba(0, 0, 0, 0.28);
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
  font-size: 13px;
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
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 700;
  color: var(--warn);
  background: rgba(240, 180, 41, 0.15);
  border: 1px solid rgba(240, 180, 41, 0.4);
  padding: 2px 8px;
  border-radius: 999px;
  -webkit-app-region: no-drag;
}
.ro-badge.locked:hover {
  background: rgba(240, 180, 41, 0.28);
}
.ro-badge.unlocked {
  color: var(--ok);
  background: rgba(74, 222, 128, 0.14);
  border-color: rgba(74, 222, 128, 0.45);
  font-variant-numeric: tabular-nums;
}
.ro-badge.unlocked:hover {
  background: rgba(74, 222, 128, 0.26);
}
.txn-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 700;
  color: var(--warn);
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
  font-size: 11px;
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
  font-size: 10px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  white-space: nowrap;
}
.sb-tag.ro,
.sb-tag.tx {
  color: var(--warn);
  background: rgba(240, 180, 41, 0.12);
  border-color: rgba(240, 180, 41, 0.32);
}
.sb-tag.wr {
  color: var(--ok);
  background: rgba(74, 222, 128, 0.12);
  border-color: rgba(74, 222, 128, 0.32);
  font-variant-numeric: tabular-nums;
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
  display: inline-flex;
  align-items: center;
  color: var(--accent);
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
  color: var(--accent);
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
  color: var(--warn);
  font-size: 9px;
}
.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  width: 16px;
  height: 16px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}
/* Reveal the close affordance only on the hovered/active tab — less persistent
   clutter across a full strip of tabs. */
.tab:hover .tab-close,
.tab.on .tab-close {
  opacity: 1;
}
.tab-close:hover {
  background: var(--bg-active);
  color: var(--text);
}
.tab-add {
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
.table-note {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 7px 16px;
  background: var(--accent-soft);
  border-bottom: 1px solid var(--border-soft);
  font-size: 12px;
  color: var(--text);
}
.table-note > :deep(.dd-icon) {
  color: var(--accent);
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
  font-size: 11px;
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
  flex-wrap: wrap;
  gap: 7px 8px;
  padding: 9px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
/* Keep controls full-size and let the row wrap on narrow windows rather than
   squishing or clipping them — calmer than a crowded single line. */
.toolbar > * {
  flex-shrink: 0;
}
.toolbar .hint {
  color: var(--text-faint);
  font-size: 11px;
}
/* Thin indeterminate progress under the toolbar while a query/table is busy. */
.loading-bar {
  position: relative;
  flex: none;
  height: 2px;
  overflow: hidden;
  background: var(--accent-soft);
}
.loading-bar::after {
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
  font-size: 16px;
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
  font-size: 11.5px;
  color: var(--text-dim);
  padding: 0 9px;
  min-width: 58px;
  text-align: center;
}
/* Icon-only ghost buttons in toolbars: square, no text padding. */
.tb-icon {
  padding: 5px 9px;
  font-size: 14px;
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
.btn.is-saved .dd-icon {
  fill: currentColor;
}
.cancel-btn {
  color: var(--danger);
}
.cancel-btn:hover {
  background: rgba(229, 97, 106, 0.14);
}
.ai-btn {
  color: var(--accent);
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
  font-size: 12px;
  color: var(--text-dim);
}
.lint-bar:hover {
  background: var(--bg-hover);
}
.lint-ic.warn {
  color: var(--warn);
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
  font-size: 10px;
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
  font-size: 12px;
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
  font-size: 11.5px;
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
  color: var(--accent);
  font-weight: 600;
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
