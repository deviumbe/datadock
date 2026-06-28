<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useWorkspace } from '../stores/workspace'
import { useTabs } from '../stores/tabs'
import { sqlDialect, type FilterOp, type QueryResult, type ChartType, SQL_DRIVERS } from '@shared/types'
import Icon from './Icon.vue'
import ResultsGrid from './ResultsGrid.vue'
import ChartRender from './ChartRender.vue'
import { canChart, autoDetect } from '../lib/chartOption'

const PREVIEW_LIMIT = 50
const PREVIEW_CHART_TYPES: ChartType[] = ['bar', 'line', 'area', 'pie']

const props = defineProps<{ connId: string }>()

const ws = useWorkspace()
const tabsStore = useTabs()

// ---- types & state ---------------------------------------------------------

type AggFn = '' | 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'

interface QTable {
  name: string
  alias: string
}
interface QJoin {
  id: string
  leftTable: string
  leftColumn: string
  rightTable: string
  rightColumn: string
  type: 'INNER' | 'LEFT' | 'RIGHT'
  enabled: boolean
}
interface QFilter {
  id: string
  mode: 'simple' | 'raw'
  connector: 'AND' | 'OR'
  column: string
  op: FilterOp
  value: string
  raw: string
}
interface QHaving {
  id: string
  ref: string // select-item id of an aggregate
  op: '=' | '!=' | '<' | '<=' | '>' | '>='
  value: string
}
interface QSort {
  key: string
  dir: 'ASC' | 'DESC'
}

const selectedTables = ref<QTable[]>([])
const selectedColumns = ref<Record<string, string[]>>({})
const colAgg = ref<Record<string, Record<string, AggFn>>>({})
const colAlias = ref<Record<string, Record<string, string>>>({})
const distinct = ref(false)
const countStar = ref(false)
const joins = ref<QJoin[]>([])
const filters = ref<QFilter[]>([])
const having = ref<QHaving[]>([])
const orderBy = ref<QSort[]>([])
const limit = ref<number | null>(null)
const offset = ref<number | null>(null)

// ---- connection info -------------------------------------------------------

const driver = computed(() => ws.findConnection(props.connId)?.driver ?? 'postgres')
const dialect = computed(() => sqlDialect(driver.value))
const isSql = computed(() => (SQL_DRIVERS as string[]).includes(driver.value))
const tableQuote = computed(() => (dialect.value === 'mysql' ? '`' : '"'))

const tables = computed(() => ws.tables)
const erModel = computed(() => ws.erModels[props.connId])
if (!erModel.value) void ws.loadErModel(props.connId).catch(() => {})

const schema = computed(() => ws.schemas[props.connId] ?? {})
const tableSearch = ref('')

const filteredAvailable = computed(() => {
  const qs = tableSearch.value.toLowerCase().trim()
  const added = new Set(selectedTables.value.map((t) => t.name))
  let list = tables.value.filter((t) => !added.has(t.name))
  if (qs) list = list.filter((t) => t.name.toLowerCase().includes(qs))
  return list
})

// ---- helpers ---------------------------------------------------------------

let uidCounter = 0
const uid = (): string => `vqb-${Date.now()}-${uidCounter++}`
const q = (name: string): string => `${tableQuote.value}${name}${tableQuote.value}`
const multi = computed(() => selectedTables.value.length > 1)

function makeAlias(tableName: string, taken: Set<string>): string {
  const base =
    tableName
      .split(/[_\s]/)
      .map((p) => p[0]?.toLowerCase() ?? '')
      .join('') || tableName.slice(0, 2).toLowerCase()
  let alias = base
  let i = 2
  while (taken.has(alias)) alias = `${base}${i++}`
  return alias
}
function tableType(name: string): 'view' | 'table' {
  return tables.value.find((x) => x.name === name)?.type === 'view' ? 'view' : 'table'
}
function pkCols(tableName: string): string[] {
  const t = erModel.value?.tables.find((x) => x.name === tableName)
  return t?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name) ?? []
}
function fkCols(tableName: string): string[] {
  const t = erModel.value?.tables.find((x) => x.name === tableName)
  return t?.columns.filter((c) => c.isForeignKey).map((c) => c.name) ?? []
}
function colsOfTable(name: string): string[] {
  return schema.value[name] ?? []
}
function colRef(table: string, col: string): string {
  return multi.value ? `${q(table)}.${q(col)}` : q(col)
}
function isChecked(table: string, col: string): boolean {
  return (selectedColumns.value[table] ?? []).includes(col)
}
function aggOf(table: string, col: string): AggFn {
  return colAgg.value[table]?.[col] ?? ''
}
function aliasOf(table: string, col: string): string {
  return colAlias.value[table]?.[col] ?? ''
}

// ---- select items (the query's output columns) -----------------------------

interface SelectItem {
  id: string
  expr: string // SQL expression, no alias
  exprAs: string // expression + AS alias
  sortRef: string // what ORDER BY should reference
  label: string
  isAgg: boolean
}

const selectItems = computed<SelectItem[]>(() => {
  const items: SelectItem[] = []
  for (const t of selectedTables.value) {
    for (const col of selectedColumns.value[t.name] ?? []) {
      const ref = colRef(t.name, col)
      const fn = aggOf(t.name, col)
      const userAlias = aliasOf(t.name, col).trim()
      const expr = fn ? `${fn}(${ref})` : ref
      const defAlias = fn ? `${fn.toLowerCase()}_${col}` : ''
      const finalAlias = userAlias || defAlias
      items.push({
        id: `${t.name}.${col}`,
        expr,
        exprAs: finalAlias ? `${expr} AS ${q(finalAlias)}` : expr,
        sortRef: finalAlias ? q(finalAlias) : expr,
        label: multi.value ? `${t.name}.${col}` : col,
        isAgg: !!fn
      })
    }
  }
  if (countStar.value) {
    items.push({
      id: '*',
      expr: 'COUNT(*)',
      exprAs: `COUNT(*) AS ${q('count')}`,
      sortRef: q('count'),
      label: 'COUNT(*)',
      isAgg: true
    })
  }
  return items
})
const aggItems = computed(() => selectItems.value.filter((i) => i.isAgg))
const hasAgg = computed(() => aggItems.value.length > 0)
const groupRefs = computed(() =>
  hasAgg.value ? selectItems.value.filter((i) => !i.isAgg).map((i) => i.expr) : []
)
const groupLabels = computed(() =>
  selectItems.value.filter((i) => !i.isAgg).map((i) => i.label)
)

// All real (table) columns currently available, for filter/sort pickers.
function availableColumns(): { table: string; column: string; label: string }[] {
  const out: { table: string; column: string; label: string }[] = []
  for (const t of selectedTables.value)
    for (const c of colsOfTable(t.name))
      out.push({ table: t.name, column: c, label: multi.value ? `${t.name}.${c}` : c })
  return out
}
const sortOptions = computed(() => {
  const opts: { key: string; label: string; ref: string }[] = availableColumns().map((c) => ({
    key: `c:${c.table}.${c.column}`,
    label: c.label,
    ref: colRef(c.table, c.column)
  }))
  for (const a of aggItems.value) opts.push({ key: `a:${a.id}`, label: a.label, ref: a.sortRef })
  return opts
})

// ---- table management ------------------------------------------------------

function addTable(tableName: string): void {
  const taken = new Set(selectedTables.value.map((t) => t.alias))
  selectedTables.value.push({ name: tableName, alias: makeAlias(tableName, taken) })
  selectedColumns.value[tableName] = [...colsOfTable(tableName)]
  autoDetectJoins(tableName)
}
function removeTable(tableName: string): void {
  selectedTables.value = selectedTables.value.filter((t) => t.name !== tableName)
  delete selectedColumns.value[tableName]
  delete colAgg.value[tableName]
  delete colAlias.value[tableName]
  joins.value = joins.value.filter((j) => j.leftTable !== tableName && j.rightTable !== tableName)
  filters.value = filters.value.filter((f) => f.mode === 'raw' || f.column.split('.')[0] !== tableName)
  orderBy.value = orderBy.value.filter((o) => !o.key.includes(`:${tableName}.`))
}
function toggleColumn(tableName: string, colName: string): void {
  const cols = selectedColumns.value[tableName] ?? []
  const idx = cols.indexOf(colName)
  if (idx >= 0) cols.splice(idx, 1)
  else cols.push(colName)
  selectedColumns.value = { ...selectedColumns.value, [tableName]: [...cols] }
}
function selectAllCols(tableName: string): void {
  selectedColumns.value = { ...selectedColumns.value, [tableName]: [...colsOfTable(tableName)] }
}
function deselectAllCols(tableName: string): void {
  selectedColumns.value = { ...selectedColumns.value, [tableName]: [] }
}
function setAgg(table: string, col: string, fn: AggFn): void {
  colAgg.value = { ...colAgg.value, [table]: { ...(colAgg.value[table] ?? {}), [col]: fn } }
}
function setAlias(table: string, col: string, val: string): void {
  colAlias.value = { ...colAlias.value, [table]: { ...(colAlias.value[table] ?? {}), [col]: val } }
}
// Per-column "summarise / rename" controls are hidden by default to keep the
// list a clean one-line checklist; this tracks which rows have them revealed.
const colKey = (t: string, c: string): string => `${t}.${c}`
const fxOpen = ref<Set<string>>(new Set())
function toggleFx(t: string, c: string): void {
  const s = new Set(fxOpen.value)
  const k = colKey(t, c)
  if (s.has(k)) s.delete(k)
  else s.add(k)
  fxOpen.value = s
}
function ctrlsShown(t: string, c: string): boolean {
  return fxOpen.value.has(colKey(t, c)) || !!aggOf(t, c) || !!aliasOf(t, c)
}

// ---- join management -------------------------------------------------------

function autoDetectJoins(newTable: string): void {
  const er = erModel.value
  if (!er) return
  const names = selectedTables.value.map((t) => t.name)
  for (const rel of er.relations) {
    const exists = joins.value.some(
      (j) =>
        (j.leftTable === rel.fromTable && j.rightTable === rel.toTable) ||
        (j.leftTable === rel.toTable && j.rightTable === rel.fromTable)
    )
    if (exists) continue
    if (rel.fromTable === newTable && names.includes(rel.toTable))
      joins.value.push({ id: uid(), leftTable: rel.toTable, leftColumn: rel.toColumn, rightTable: rel.fromTable, rightColumn: rel.fromColumn, type: 'INNER', enabled: true })
    else if (rel.toTable === newTable && names.includes(rel.fromTable))
      joins.value.push({ id: uid(), leftTable: rel.fromTable, leftColumn: rel.fromColumn, rightTable: rel.toTable, rightColumn: rel.toColumn, type: 'INNER', enabled: true })
  }
}
function addJoin(): void {
  const a = selectedTables.value[0]?.name ?? ''
  const b = selectedTables.value[1]?.name ?? a
  joins.value.push({
    id: uid(),
    leftTable: a,
    leftColumn: colsOfTable(a)[0] ?? '',
    rightTable: b,
    rightColumn: fkCols(b)[0] ?? colsOfTable(b)[0] ?? '',
    type: 'INNER',
    enabled: true
  })
}
function removeJoin(id: string): void {
  joins.value = joins.value.filter((j) => j.id !== id)
}

// Plan the JOINs so every table beyond the first is introduced exactly once
// (chaining off already-joined tables). Tables with no path become a flagged
// cross join so the user can spot + fix the missing condition.
const joinPlan = computed<{ clauses: string[]; unjoined: string[] }>(() => {
  const first = selectedTables.value[0]
  if (!first) return { clauses: [], unjoined: [] }
  const enabled = joins.value.filter(
    (j) => j.enabled && j.leftTable && j.rightTable && j.leftColumn && j.rightColumn
  )
  const joined = new Set([first.name])
  const used = new Set<string>()
  const clauses: string[] = []
  let progress = true
  while (progress) {
    progress = false
    for (const j of enabled) {
      if (used.has(j.id)) continue
      const lJ = joined.has(j.leftTable)
      const rJ = joined.has(j.rightTable)
      const on = `${q(j.leftTable)}.${q(j.leftColumn)} = ${q(j.rightTable)}.${q(j.rightColumn)}`
      if (lJ && !rJ) {
        clauses.push(`${j.type} JOIN ${q(j.rightTable)} ON ${on}`)
        joined.add(j.rightTable)
        used.add(j.id)
        progress = true
      } else if (rJ && !lJ) {
        clauses.push(`${j.type} JOIN ${q(j.leftTable)} ON ${on}`)
        joined.add(j.leftTable)
        used.add(j.id)
        progress = true
      }
    }
  }
  const unjoined: string[] = []
  for (const t of selectedTables.value.slice(1)) {
    if (!joined.has(t.name)) {
      clauses.push(`CROSS JOIN ${q(t.name)}`)
      unjoined.push(t.name)
    }
  }
  return { clauses, unjoined }
})

// ---- filter / having / sort management -------------------------------------

// Plain-language operator labels (no SQL symbols) so non-technical users can read them.
const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: '=', label: 'is' },
  { value: '!=', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'starts', label: 'starts with' },
  { value: '>', label: 'is more than' },
  { value: '>=', label: 'is at least' },
  { value: '<', label: 'is less than' },
  { value: '<=', label: 'is at most' },
  { value: 'is null', label: 'is empty' },
  { value: 'not null', label: 'is not empty' }
]
const HAVING_OPS: { value: QHaving['op']; label: string }[] = [
  { value: '>', label: 'is more than' },
  { value: '>=', label: 'is at least' },
  { value: '<', label: 'is less than' },
  { value: '<=', label: 'is at most' },
  { value: '=', label: 'is' },
  { value: '!=', label: 'is not' }
]

// Plain words for aggregate functions, shown in the column dropdown and summary.
const AGG_LABEL: Record<AggFn, string> = {
  '': 'Show value',
  COUNT: 'Count',
  SUM: 'Total',
  AVG: 'Average',
  MIN: 'Smallest',
  MAX: 'Largest'
}
function opPhrase(op: FilterOp): string {
  return FILTER_OPS.find((o) => o.value === op)?.label ?? String(op)
}
function joinExplain(j: QJoin): string {
  if (j.type === 'INNER') return `Only keeps ${j.leftTable} and ${j.rightTable} rows that have a match in each other.`
  if (j.type === 'LEFT') return `Keeps every ${j.leftTable} row, even when there's no matching ${j.rightTable}.`
  return `Keeps every ${j.rightTable} row, even when there's no matching ${j.leftTable}.`
}

function addFilter(): void {
  const cols = availableColumns()
  filters.value.push({
    id: uid(),
    mode: 'simple',
    connector: 'AND',
    column: cols.length ? `${cols[0].table}.${cols[0].column}` : '',
    op: '=',
    value: '',
    raw: ''
  })
}
function removeFilter(id: string): void {
  filters.value = filters.value.filter((f) => f.id !== id)
}
function addHaving(): void {
  having.value.push({ id: uid(), ref: aggItems.value[0]?.id ?? '', op: '>', value: '' })
}
function removeHaving(id: string): void {
  having.value = having.value.filter((h) => h.id !== id)
}
function addSort(): void {
  const o = sortOptions.value[0]
  if (o) orderBy.value.push({ key: o.key, dir: 'ASC' })
}
function removeSort(idx: number): void {
  orderBy.value.splice(idx, 1)
}
function toggleSortDir(idx: number): void {
  orderBy.value[idx].dir = orderBy.value[idx].dir === 'ASC' ? 'DESC' : 'ASC'
}

// ---- SQL generation --------------------------------------------------------

function whereRef(column: string): string {
  const parts = column.split('.')
  return multi.value && parts.length >= 2
    ? `${q(parts[0])}.${q(parts.slice(1).join('.'))}`
    : q(parts[parts.length - 1])
}
function simpleCond(f: QFilter): string {
  if (!f.column) return ''
  const ref = whereRef(f.column)
  const val = f.value.replace(/'/g, "''")
  switch (f.op) {
    case 'is null':
      return `${ref} IS NULL`
    case 'not null':
      return `${ref} IS NOT NULL`
    case 'contains':
      return `${ref} LIKE '%${val}%'`
    case 'starts':
      return `${ref} LIKE '${val}%'`
    default:
      return `${ref} ${f.op} '${val}'`
  }
}

function buildSql(forceLimit?: number): string {
  if (selectedTables.value.length === 0) return ''
  const first = selectedTables.value[0]
  // Effective row cap: the user's limit, but never above forceLimit (preview).
  const effLimit =
    forceLimit != null ? Math.min(limit.value ?? forceLimit, forceLimit) : limit.value

  const selectList = selectItems.value.length
    ? selectItems.value.map((i) => i.exprAs).join(', ')
    : '*'
  let sql = `SELECT ${distinct.value && !hasAgg.value ? 'DISTINCT ' : ''}${selectList}\n`
  sql += `FROM ${q(first.name)}\n`

  for (const c of joinPlan.value.clauses) sql += `${c}\n`

  // WHERE
  let whereStr = ''
  for (const f of filters.value) {
    const cond = f.mode === 'raw' ? f.raw.trim() : simpleCond(f)
    if (!cond) continue
    whereStr = whereStr === '' ? cond : `${whereStr}\n  ${f.connector} ${cond}`
  }
  if (whereStr) sql += `WHERE ${whereStr}\n`

  // GROUP BY (derived from non-aggregated output columns)
  if (groupRefs.value.length) sql += `GROUP BY ${groupRefs.value.join(', ')}\n`

  // HAVING
  if (hasAgg.value && having.value.length) {
    const parts: string[] = []
    for (const h of having.value) {
      const item = aggItems.value.find((a) => a.id === h.ref)
      if (!item || h.value.trim() === '') continue
      const v = /^-?\d+(\.\d+)?$/.test(h.value.trim()) ? h.value.trim() : `'${h.value.replace(/'/g, "''")}'`
      parts.push(`${item.expr} ${h.op} ${v}`)
    }
    if (parts.length) sql += `HAVING ${parts.join('\n  AND ')}\n`
  }

  // ORDER BY
  if (orderBy.value.length) {
    const ob: string[] = []
    for (const o of orderBy.value) {
      const opt = sortOptions.value.find((x) => x.key === o.key)
      if (opt) ob.push(`${opt.ref} ${o.dir}`)
    }
    if (ob.length) sql += `ORDER BY ${ob.join(', ')}\n`
  }

  // LIMIT / OFFSET
  if (effLimit !== null && effLimit !== undefined && effLimit > 0) {
    if (dialect.value === 'mssql') {
      if (offset.value !== null && offset.value > 0) {
        if (orderBy.value.length === 0) sql += `ORDER BY (SELECT NULL)\n`
        sql += `OFFSET ${offset.value} ROWS\nFETCH NEXT ${effLimit} ROWS ONLY\n`
      } else {
        sql = sql.replace(/^SELECT /i, `SELECT TOP ${effLimit} `)
      }
    } else {
      sql += `LIMIT ${effLimit}\n`
      if (offset.value !== null && offset.value > 0) sql += `OFFSET ${offset.value}\n`
    }
  }
  return sql.trimEnd() + ';'
}
const generatedSql = computed(() => buildSql())
const previewSql = computed(() => buildSql(PREVIEW_LIMIT))

// ---- plain-English summary -------------------------------------------------
// A living, jargon-free sentence describing exactly what the query will do, so
// a non-SQL user can read back what they've built.

function list(items: string[]): string {
  const a = items.filter(Boolean)
  if (a.length === 0) return ''
  if (a.length === 1) return a[0]
  if (a.length === 2) return `${a[0]} and ${a[1]}`
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`
}
const aggDescriptions = computed(() => {
  const out: string[] = []
  for (const t of selectedTables.value)
    for (const col of selectedColumns.value[t.name] ?? []) {
      const fn = aggOf(t.name, col)
      if (!fn) continue
      const label = multi.value ? `${t.name}.${col}` : col
      if (fn === 'COUNT') out.push(`the count of ${label}`)
      else if (fn === 'SUM') out.push(`the total of ${label}`)
      else if (fn === 'AVG') out.push(`the average ${label}`)
      else if (fn === 'MIN') out.push(`the smallest ${label}`)
      else if (fn === 'MAX') out.push(`the largest ${label}`)
    }
  if (countStar.value) out.push('the number of rows')
  return out
})
function filterPhrase(f: QFilter): string {
  if (f.mode === 'raw') return f.raw.trim()
  if (!f.column) return ''
  const label = multi.value ? f.column : f.column.split('.').pop() ?? f.column
  const op = opPhrase(f.op)
  if (f.op === 'is null' || f.op === 'not null') return `${label} ${op}`
  const v = f.value === '' ? '…' : /^-?\d+(\.\d+)?$/.test(f.value) ? f.value : `“${f.value}”`
  return `${label} ${op} ${v}`
}
const plainSummary = computed(() => {
  if (!selectedTables.value.length) return ''
  const first = selectedTables.value[0].name
  let s: string
  if (hasAgg.value) {
    s = `Show ${list(aggDescriptions.value)}`
    if (groupLabels.value.length) s += ` for each ${list(groupLabels.value)}`
    s += ` in ${first}`
  } else {
    const cols = selectItems.value.map((i) => i.label)
    const total = availableColumns().length
    let what: string
    if (cols.length === 0 || cols.length === total) what = 'all columns'
    else if (cols.length > 6) what = `${cols.length} columns`
    else what = list(cols)
    s = `Show ${what} from ${first}`
  }
  const joined = selectedTables.value.slice(1).map((t) => t.name)
  if (joined.length) s += `, combined with ${list(joined)}`
  const conds = filters.value.map((f) => ({ text: filterPhrase(f), conn: f.connector })).filter((c) => c.text)
  if (conds.length) {
    let w = conds[0].text
    for (let i = 1; i < conds.length; i++) w += ` ${conds[i].conn.toLowerCase()} ${conds[i].text}`
    s += ` — but only where ${w}`
  }
  if (distinct.value && !hasAgg.value) s += ', with duplicate rows removed'
  if (orderBy.value.length) {
    const so = orderBy.value
      .map((o) => {
        const opt = sortOptions.value.find((x) => x.key === o.key)
        return opt ? `${opt.label} (${o.dir === 'ASC' ? 'low to high' : 'high to low'})` : ''
      })
      .filter(Boolean)
    if (so.length) s += `, sorted by ${list(so)}`
  }
  if (limit.value) s += `, showing at most ${limit.value} row${limit.value === 1 ? '' : 's'}`
  return s + '.'
})
const showSql = ref(false)

// ---- live preview ----------------------------------------------------------
// Runs the built query (capped to PREVIEW_LIMIT rows) and shows the grid, so the
// user sees real data as they build — no need to imagine the result.
const preview = ref<QueryResult | null>(null)
const previewError = ref('')
const previewLoading = ref(false)
const previewOpen = ref(true)
let previewToken = 0
let previewTimer: ReturnType<typeof setTimeout> | undefined

async function runPreview(): Promise<void> {
  const sql = previewSql.value
  if (!sql || !previewOpen.value) return
  const token = ++previewToken
  previewLoading.value = true
  previewError.value = ''
  try {
    const res = await window.api.db.query(props.connId, sql)
    if (token !== previewToken) return
    preview.value = res
  } catch (e) {
    if (token !== previewToken) return
    preview.value = null
    previewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (token === previewToken) previewLoading.value = false
  }
}
function schedulePreview(): void {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => void runPreview(), 450)
}
// Table ↔ chart view for the preview (reuses the app's instant-visualisation).
const previewView = ref<'table' | 'chart'>('table')
const previewChartType = ref<ChartType>('bar')
const previewChartable = computed(() => canChart(preview.value))
const effectiveView = computed(() => (previewView.value === 'chart' && previewChartable.value ? 'chart' : 'table'))
function showChart(): void {
  if (preview.value) previewChartType.value = autoDetect(preview.value).type
  previewView.value = 'chart'
}
watch([previewSql, previewOpen], () => {
  if (previewOpen.value && previewSql.value) schedulePreview()
  else if (!previewSql.value) preview.value = null
})
onBeforeUnmount(() => previewTimer && clearTimeout(previewTimer))

// ---- distinct value suggestions (point-and-click filter values) ------------
const distinctCache = ref<Record<string, string[]>>({})
async function loadDistinct(column: string): Promise<void> {
  if (!column || distinctCache.value[column] != null) return
  const parts = column.split('.')
  if (parts.length < 2) return
  const table = parts[0]
  const col = parts.slice(1).join('.')
  distinctCache.value = { ...distinctCache.value, [column]: [] } // reserve (avoid re-query)
  try {
    const top = dialect.value === 'mssql' ? 'TOP 50 ' : ''
    const tail = dialect.value === 'mssql' ? '' : ' LIMIT 50'
    const sql = `SELECT DISTINCT ${top}${q(col)} AS v FROM ${q(table)} WHERE ${q(col)} IS NOT NULL${tail}`
    const res = await window.api.db.query(props.connId, sql)
    const vals = res.rows.map((r) => (r[0] == null ? '' : String(r[0]))).filter((v) => v !== '')
    distinctCache.value = { ...distinctCache.value, [column]: vals }
  } catch {
    /* best-effort — suggestions just won't appear */
  }
}
function suggestionsFor(column: string): string[] {
  return distinctCache.value[column] ?? []
}

// ---- actions ---------------------------------------------------------------

const copied = ref(false)
async function copySql(): Promise<void> {
  try {
    await navigator.clipboard.writeText(generatedSql.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1400)
  } catch {
    /* clipboard unavailable */
  }
}
async function openInQueryTab(): Promise<void> {
  if (!generatedSql.value) return
  const tab = tabsStore.openQueryWith(props.connId, generatedSql.value, 'Built Query')
  await tabsStore.run(tab)
}
function clearAll(): void {
  selectedTables.value = []
  selectedColumns.value = {}
  colAgg.value = {}
  colAlias.value = {}
  distinct.value = false
  countStar.value = false
  joins.value = []
  filters.value = []
  having.value = []
  orderBy.value = []
  limit.value = null
  offset.value = null
}

const openSections = ref({ joins: true, filters: true, having: true, sort: false, limit: false })
</script>

<template>
  <div class="vqb" v-if="isSql">
    <!-- Toolbar -->
    <div class="vqb-toolbar">
      <Icon name="diagram" />
      <strong>Query Builder</strong>
      <span class="vqb-muted">{{ selectedTables.length }} table{{ selectedTables.length !== 1 ? 's' : '' }}</span>
      <div class="vqb-spacer" />
      <button class="btn btn-ghost" :disabled="!selectedTables.length" @click="clearAll" title="Reset the whole builder">Clear</button>
      <button class="btn btn-ghost" :disabled="!generatedSql" @click="copySql" :title="copied ? 'Copied!' : 'Copy generated SQL'">
        <Icon :name="copied ? 'check' : 'code'" /> {{ copied ? 'Copied' : 'Copy SQL' }}
      </button>
      <button class="btn btn-primary" :disabled="!generatedSql" @click="openInQueryTab" title="Open in a new query tab and run">
        <Icon name="play" :size="13" /> Run
      </button>
    </div>

    <div class="vqb-body">
      <!-- Left sidebar: available tables -->
      <aside class="vqb-sidebar">
        <div class="vqb-sidebar-head">
          <input class="input" v-model="tableSearch" placeholder="Filter tables…" />
        </div>
        <div class="vqb-sidebar-hint">Click a table to add it</div>
        <div class="vqb-table-list">
          <div
            v-for="t in filteredAvailable"
            :key="t.name"
            class="vqb-table-item"
            title="Add to query"
            @click="addTable(t.name)"
          >
            <span class="vqb-ticon"><Icon :name="t.type === 'view' ? 'view' : 'table'" :size="13" /></span>
            <span class="vqb-tname">{{ t.name }}</span>
            <span class="vqb-tadd"><Icon name="plus" :size="13" /></span>
          </div>
          <div v-if="filteredAvailable.length === 0" class="vqb-empty-list">
            {{ tableSearch ? 'No matching tables' : 'All tables added' }}
          </div>
        </div>
      </aside>

      <!-- Main canvas + live preview -->
      <div class="vqb-main">
      <div class="vqb-canvas">
        <!-- Empty state -->
        <div v-if="selectedTables.length === 0" class="vqb-empty">
          <div class="vqb-empty-icon"><Icon name="diagram" :size="30" /></div>
          <h3>Build a query without writing SQL</h3>
          <p>Pick a table from the left, tick the columns you want, then add filters, joins or sorting. The SQL is written for you and you can run it in one click.</p>
          <div class="vqb-steps">
            <div class="vqb-step"><span class="vqb-step-n">1</span> Add a table</div>
            <div class="vqb-step"><span class="vqb-step-n">2</span> Tick the columns you want</div>
            <div class="vqb-step"><span class="vqb-step-n">3</span> Add filters &amp; press Run</div>
          </div>
          <p class="vqb-hint">No SQL needed — related tables are linked for you automatically.</p>
        </div>

        <template v-else>
          <!-- Plain-English summary: what this will do, in everyday words -->
          <div class="vqb-summary">
            <span class="vqb-summary-ic"><Icon name="info" :size="14" /></span>
            <p>{{ plainSummary }}</p>
          </div>

          <!-- Output options -->
          <div class="vqb-options">
            <label class="vqb-opt" :class="{ off: hasAgg }" title="Hide rows that are exact duplicates of each other">
              <input type="checkbox" v-model="distinct" :disabled="hasAgg" />
              <span>Remove duplicate rows</span>
            </label>
            <label class="vqb-opt" title="Add a column that simply counts how many rows there are">
              <input type="checkbox" v-model="countStar" />
              <span>Count the rows</span>
            </label>
            <div class="vqb-spacer" />
            <span v-if="hasAgg && groupLabels.length" class="vqb-group-note" title="You'll get one row for each of these">
              <Icon name="info" :size="12" /> one row per {{ groupLabels.join(', ') }}
            </span>
          </div>

          <!-- Tables & columns -->
          <div class="vqb-section vqb-plain">
            <div class="vqb-section-head">
              <span class="vqb-section-title">Your data</span>
            </div>
            <p class="vqb-desc">Tick the columns (fields) you want to see. Want a total or average instead? Give a column a summary like <em>Total</em> or <em>Count</em> — the rest become the groups.</p>
            <div class="vqb-table-cards">
              <div v-for="t in selectedTables" :key="t.name" class="vqb-card">
                <div class="vqb-card-head">
                  <Icon :name="tableType(t.name) === 'view' ? 'view' : 'table'" :size="14" />
                  <span class="vqb-card-name">{{ t.name }}</span>
                  <span class="vqb-card-count">{{ (selectedColumns[t.name] ?? []).length }}/{{ colsOfTable(t.name).length }}</span>
                  <button class="vqb-card-btn" @click="selectAllCols(t.name)" title="Select all columns">All</button>
                  <button class="vqb-card-btn" @click="deselectAllCols(t.name)" title="Deselect all">None</button>
                  <button class="vqb-card-remove" @click="removeTable(t.name)" title="Remove table"><Icon name="x" :size="13" /></button>
                </div>
                <div class="vqb-card-cols">
                  <div v-if="colsOfTable(t.name).length === 0" class="vqb-no-cols">No columns found — try reloading tables</div>
                  <div
                    v-for="col in colsOfTable(t.name)"
                    :key="col"
                    class="vqb-col"
                    :class="{ checked: isChecked(t.name, col), pk: pkCols(t.name).includes(col), fk: fkCols(t.name).includes(col) }"
                  >
                    <label class="vqb-col-main">
                      <input type="checkbox" :checked="isChecked(t.name, col)" @change="toggleColumn(t.name, col)" />
                      <span class="vqb-col-name">{{ col }}</span>
                      <span v-if="pkCols(t.name).includes(col)" class="vqb-badge pk" title="Primary key">PK</span>
                      <span v-else-if="fkCols(t.name).includes(col)" class="vqb-badge fk" title="Foreign key">FK</span>
                    </label>
                    <button
                      v-if="isChecked(t.name, col)"
                      class="vqb-fx"
                      :class="{ on: ctrlsShown(t.name, col) }"
                      title="Summarise (total, count…) or rename this column"
                      @click="toggleFx(t.name, col)"
                    >∑</button>
                    <div v-if="isChecked(t.name, col) && ctrlsShown(t.name, col)" class="vqb-col-ctrls">
                      <select
                        class="select vqb-mini"
                        :value="aggOf(t.name, col)"
                        title="Show each value, or summarise the column"
                        @change="setAgg(t.name, col, ($event.target as HTMLSelectElement).value as AggFn)"
                      >
                        <option v-for="(lbl, fn) in AGG_LABEL" :key="fn" :value="fn">{{ lbl }}</option>
                      </select>
                      <input
                        class="input vqb-mini vqb-alias"
                        :value="aliasOf(t.name, col)"
                        placeholder="rename…"
                        title="Optional: rename this column in the results"
                        @input="setAlias(t.name, col, ($event.target as HTMLInputElement).value)"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Joins -->
          <div v-if="multi" class="vqb-section">
            <button class="vqb-section-toggle" @click="openSections.joins = !openSections.joins">
              <span class="vqb-caret" :class="{ open: openSections.joins }"><Icon name="chevronRight" :size="13" /></span>
              <span class="vqb-section-title">Combine tables</span>
              <span v-if="joins.length" class="vqb-section-count">{{ joins.filter((j) => j.enabled).length }}/{{ joins.length }}</span>
            </button>
            <div v-if="openSections.joins" class="vqb-section-body">
              <p class="vqb-desc">How the tables connect to each other. These are matched up for you automatically — you usually don't need to touch them.</p>
              <div v-if="joinPlan.unjoined.length" class="vqb-warn">
                <Icon name="warn" :size="13" /> {{ joinPlan.unjoined.join(', ') }} {{ joinPlan.unjoined.length === 1 ? 'isn’t' : 'aren’t' }} linked to the rest, so every row will be paired with every row (usually not what you want). Add a link below to fix it.
              </div>
              <div v-for="j in joins" :key="j.id" class="vqb-join-block" :class="{ disabled: !j.enabled }">
                <div class="vqb-join-row">
                  <input class="vqb-join-check" type="checkbox" :checked="j.enabled" title="Turn this link on or off" @change="j.enabled = !j.enabled" />
                  <select class="select vqb-mini vqb-join-type" v-model="j.type" title="Which rows to keep">
                    <option value="INNER">Only matching</option>
                    <option value="LEFT">Keep all {{ j.leftTable }}</option>
                    <option value="RIGHT">Keep all {{ j.rightTable }}</option>
                  </select>
                  <select class="select vqb-mini" v-model="j.leftTable" title="Table">
                    <option v-for="t in selectedTables" :key="t.name" :value="t.name">{{ t.name }}</option>
                  </select>
                  <select class="select vqb-mini" v-model="j.leftColumn" title="Field">
                    <option v-for="c in colsOfTable(j.leftTable)" :key="c" :value="c">{{ c }}</option>
                  </select>
                  <span class="vqb-join-eq">matches</span>
                  <select class="select vqb-mini" v-model="j.rightTable" title="Table">
                    <option v-for="t in selectedTables" :key="t.name" :value="t.name">{{ t.name }}</option>
                  </select>
                  <select class="select vqb-mini" v-model="j.rightColumn" title="Field">
                    <option v-for="c in colsOfTable(j.rightTable)" :key="c" :value="c">{{ c }}</option>
                  </select>
                  <button class="vqb-card-remove" @click="removeJoin(j.id)" title="Remove link"><Icon name="x" :size="12" /></button>
                </div>
                <p class="vqb-join-explain">{{ joinExplain(j) }}</p>
              </div>
              <button class="btn btn-ghost vqb-add-btn" @click="addJoin"><Icon name="plus" :size="13" /> Link another table</button>
            </div>
          </div>

          <!-- Filters (WHERE) -->
          <div class="vqb-section">
            <button class="vqb-section-toggle" @click="openSections.filters = !openSections.filters">
              <span class="vqb-caret" :class="{ open: openSections.filters }"><Icon name="chevronRight" :size="13" /></span>
              <span class="vqb-section-title">Filters</span>
              <span v-if="filters.length" class="vqb-section-count">{{ filters.length }}</span>
            </button>
            <div v-if="openSections.filters" class="vqb-section-body">
              <p class="vqb-desc">Only show rows that match. <strong>and</strong> means a row must match every line; <strong>or</strong> means it can match any. Need something fancier? The <Icon name="code" :size="11" /> button lets you type a condition yourself.</p>
              <div v-for="(f, idx) in filters" :key="f.id" class="vqb-filter-row">
                <select v-if="idx > 0" class="select vqb-mini vqb-conn" v-model="f.connector" title="Must it match this as well, or instead?">
                  <option value="AND">and</option>
                  <option value="OR">or</option>
                </select>
                <span v-else class="vqb-where-lead">where</span>
                <template v-if="f.mode === 'simple'">
                  <select class="select vqb-col-select" :value="f.column" @change="f.column = ($event.target as HTMLSelectElement).value">
                    <option value="" disabled>Column…</option>
                    <optgroup v-for="t in selectedTables" :key="t.name" :label="t.name">
                      <option v-for="col in colsOfTable(t.name)" :key="col" :value="`${t.name}.${col}`">{{ col }}</option>
                    </optgroup>
                  </select>
                  <select class="select vqb-op-select" :value="f.op" @change="f.op = ($event.target as HTMLSelectElement).value as FilterOp">
                    <option v-for="op in FILTER_OPS" :key="op.value" :value="op.value">{{ op.label }}</option>
                  </select>
                  <template v-if="f.op !== 'is null' && f.op !== 'not null'">
                    <input
                      class="input vqb-val-input"
                      v-model="f.value"
                      placeholder="Value"
                      :list="'vqb-dl-' + f.id"
                      @focus="loadDistinct(f.column)"
                    />
                    <datalist :id="'vqb-dl-' + f.id">
                      <option v-for="v in suggestionsFor(f.column)" :key="v" :value="v" />
                    </datalist>
                  </template>
                </template>
                <input
                  v-else
                  class="input vqb-raw-input"
                  v-model="f.raw"
                  placeholder="Type a condition, e.g. total > 100"
                />
                <button
                  class="vqb-mode-btn"
                  :class="{ on: f.mode === 'raw' }"
                  :title="f.mode === 'raw' ? 'Back to the simple picker' : 'Advanced: type the condition yourself'"
                  @click="f.mode = f.mode === 'raw' ? 'simple' : 'raw'"
                >
                  <Icon name="code" :size="13" />
                </button>
                <button class="vqb-card-remove" @click="removeFilter(f.id)" title="Remove filter"><Icon name="x" :size="12" /></button>
              </div>
              <button class="btn btn-ghost vqb-add-btn" @click="addFilter"><Icon name="plus" :size="13" /> Add filter</button>
            </div>
          </div>

          <!-- Having -->
          <div v-if="hasAgg" class="vqb-section">
            <button class="vqb-section-toggle" @click="openSections.having = !openSections.having">
              <span class="vqb-caret" :class="{ open: openSections.having }"><Icon name="chevronRight" :size="13" /></span>
              <span class="vqb-section-title">Filter by totals</span>
              <span v-if="having.length" class="vqb-section-count">{{ having.length }}</span>
            </button>
            <div v-if="openSections.having" class="vqb-section-body">
              <p class="vqb-desc">Keep only the groups whose total matches — e.g. only customers whose <em>total amount</em> is more than 1000.</p>
              <div v-for="h in having" :key="h.id" class="vqb-filter-row">
                <select class="select vqb-col-select" v-model="h.ref">
                  <option v-for="a in aggItems" :key="a.id" :value="a.id">{{ a.label }}</option>
                </select>
                <select class="select vqb-op-select" v-model="h.op">
                  <option v-for="op in HAVING_OPS" :key="op.value" :value="op.value">{{ op.label }}</option>
                </select>
                <input class="input vqb-val-input" v-model="h.value" placeholder="e.g. 1000" />
                <button class="vqb-card-remove" @click="removeHaving(h.id)" title="Remove"><Icon name="x" :size="12" /></button>
              </div>
              <button class="btn btn-ghost vqb-add-btn" @click="addHaving"><Icon name="plus" :size="13" /> Add condition</button>
            </div>
          </div>

          <!-- Sort -->
          <div class="vqb-section">
            <button class="vqb-section-toggle" @click="openSections.sort = !openSections.sort">
              <span class="vqb-caret" :class="{ open: openSections.sort }"><Icon name="chevronRight" :size="13" /></span>
              <span class="vqb-section-title">Sort</span>
              <span v-if="orderBy.length" class="vqb-section-count">{{ orderBy.length }}</span>
            </button>
            <div v-if="openSections.sort" class="vqb-section-body">
              <p class="vqb-desc">Put the results in order. Add more than one to break ties (e.g. by date, then by name).</p>
              <div v-for="(s, idx) in orderBy" :key="idx" class="vqb-filter-row">
                <select class="select vqb-col-select" v-model="s.key">
                  <option v-for="o in sortOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
                </select>
                <button class="btn btn-ghost vqb-dir-btn" @click="toggleSortDir(idx)" title="Click to flip the order">
                  {{ s.dir === 'ASC' ? '↑ Low to high' : '↓ High to low' }}
                </button>
                <button class="vqb-card-remove" @click="removeSort(idx)" title="Remove sort"><Icon name="x" :size="12" /></button>
              </div>
              <button class="btn btn-ghost vqb-add-btn" :disabled="!sortOptions.length" @click="addSort"><Icon name="plus" :size="13" /> Add sort</button>
            </div>
          </div>

          <!-- Limit / Offset -->
          <div class="vqb-section">
            <button class="vqb-section-toggle" @click="openSections.limit = !openSections.limit">
              <span class="vqb-caret" :class="{ open: openSections.limit }"><Icon name="chevronRight" :size="13" /></span>
              <span class="vqb-section-title">Number of rows</span>
              <span v-if="limit" class="vqb-section-count">max {{ limit }}</span>
            </button>
            <div v-if="openSections.limit" class="vqb-section-body">
              <p class="vqb-desc">Only fetch the first few rows — handy for a quick preview of big tables.</p>
              <div class="vqb-filter-row">
                <label class="vqb-limit-label">Show at most</label>
                <input
                  class="input vqb-limit-input"
                  type="number"
                  :value="limit ?? ''"
                  placeholder="all rows"
                  min="1"
                  @input="limit = ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : null"
                />
                <label class="vqb-limit-label">rows, skipping the first</label>
                <input
                  class="input vqb-limit-input"
                  type="number"
                  :value="offset ?? ''"
                  placeholder="0"
                  min="0"
                  @input="offset = ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : null"
                />
              </div>
            </div>
          </div>

          <!-- SQL (optional, hidden by default) -->
          <div class="vqb-section vqb-plain vqb-sql-section">
            <button class="vqb-section-toggle" @click="showSql = !showSql">
              <span class="vqb-caret" :class="{ open: showSql }"><Icon name="chevronRight" :size="13" /></span>
              <span class="vqb-section-title">Show the SQL</span>
              <span class="vqb-sql-opt">optional</span>
            </button>
            <div v-if="showSql">
              <div class="vqb-sql-bar">
                <span class="vqb-desc" style="margin: 0; padding: 0">This is the SQL the builder writes for you — no need to understand it.</span>
                <button class="vqb-card-btn" :disabled="!generatedSql" @click="copySql">{{ copied ? 'Copied' : 'Copy' }}</button>
              </div>
              <pre class="vqb-sql"><code>{{ generatedSql }}</code></pre>
            </div>
          </div>
        </template>
      </div>

      <!-- Always-visible live preview of the actual data -->
      <section v-if="selectedTables.length" class="vqb-preview" :class="{ collapsed: !previewOpen }">
        <div class="vqb-preview-head">
          <button class="vqb-preview-titlebtn" @click="previewOpen = !previewOpen">
            <Icon name="table" :size="14" />
            <span class="vqb-preview-title">Live preview</span>
            <span v-if="previewLoading" class="vqb-prev-state">updating…</span>
            <span v-else-if="previewError" class="vqb-prev-state err">can’t run yet</span>
            <span v-else-if="preview" class="vqb-prev-count">
              {{ preview.rowCount }}{{ preview.rowCount >= PREVIEW_LIMIT ? '+' : '' }} row{{ preview.rowCount === 1 ? '' : 's' }} · {{ Math.round(preview.durationMs) }} ms
            </span>
          </button>
          <span class="vqb-spacer" />
          <template v-if="previewOpen && previewChartable">
            <div class="vqb-view-toggle">
              <button :class="{ on: effectiveView === 'table' }" @click="previewView = 'table'"><Icon name="table" :size="12" /> Table</button>
              <button :class="{ on: effectiveView === 'chart' }" @click="showChart"><Icon name="chart" :size="12" /> Chart</button>
            </div>
            <select v-if="effectiveView === 'chart'" class="select vqb-mini" v-model="previewChartType" title="Chart type">
              <option v-for="t in PREVIEW_CHART_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
          </template>
          <span class="vqb-prev-hint">first {{ PREVIEW_LIMIT }}</span>
          <button class="vqb-prev-caret" :title="previewOpen ? 'Collapse' : 'Expand'" @click="previewOpen = !previewOpen">
            <span class="vqb-caret" :class="{ open: previewOpen }"><Icon name="chevronUp" :size="14" /></span>
          </button>
        </div>
        <div v-if="previewOpen" class="vqb-preview-grid">
          <div v-if="previewError" class="vqb-prev-error"><Icon name="warn" :size="14" /><span>{{ previewError }}</span></div>
          <template v-else-if="preview && preview.columns.length">
            <div v-if="effectiveView === 'chart'" class="vqb-prev-chart"><ChartRender :type="previewChartType" :result="preview" instant /></div>
            <ResultsGrid v-else :result="preview" />
          </template>
          <div v-else class="vqb-prev-empty">{{ previewLoading ? 'Running…' : 'Pick some columns to see a preview.' }}</div>
        </div>
      </section>
      </div>
    </div>
  </div>

  <!-- Non-SQL engine message -->
  <div v-else class="vqb-non-sql">
    <div class="vqb-empty">
      <div class="vqb-empty-icon"><Icon name="warn" :size="28" /></div>
      <h3>Query Builder not available</h3>
      <p>The visual query builder works with SQL databases only.</p>
      <p class="vqb-hint">{{ driver }} does not support SQL queries.</p>
    </div>
  </div>
</template>

<style scoped>
/* ---- layout ---- */
.vqb {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-app);
}
.vqb-non-sql {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.vqb-toolbar {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 44px;
  flex: none;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.vqb-toolbar .btn {
  padding: 5px 13px;
  border-radius: 999px;
}
.vqb-muted {
  color: var(--text-faint);
  font-size: 11px;
}
.vqb-spacer {
  flex: 1;
}
.vqb-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* ---- left sidebar ---- */
.vqb-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
}
.vqb-sidebar-head {
  padding: 9px 8px 4px;
}
.vqb-sidebar-head .input {
  width: 100%;
  font-size: 12px;
  padding: 6px 10px;
}
.vqb-sidebar-hint {
  padding: 2px 12px 8px;
  font-size: 10.5px;
  color: var(--text-faint);
}
.vqb-table-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 12px;
}
.vqb-table-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
}
.vqb-table-item:hover {
  background: var(--bg-hover);
}
.vqb-ticon {
  display: inline-flex;
  align-items: center;
  color: var(--accent);
}
.vqb-tname {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vqb-tadd {
  display: inline-flex;
  color: var(--text-faint);
  opacity: 0;
  transition: opacity 0.12s;
}
.vqb-table-item:hover .vqb-tadd {
  opacity: 1;
}
.vqb-empty-list {
  color: var(--text-faint);
  padding: 12px 10px;
  font-size: 12px;
  text-align: center;
}

/* ---- main canvas ---- */
/* Right side = scrolling builder on top, pinned live-preview at the bottom. */
.vqb-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.vqb-canvas {
  flex: 1;
  /* Must be able to shrink below its content's intrinsic width, otherwise the
     canvas overflows the (hidden) body and every section is clipped on the
     right. */
  min-width: 0;
  overflow-y: auto;
  padding: 16px 20px 48px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ---- live preview ---- */
.vqb-preview {
  flex: none;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-strong);
  background: var(--bg-panel);
}
.vqb-preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px 6px 14px;
  color: var(--text-dim);
}
.vqb-preview-titlebtn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.vqb-preview-titlebtn:hover {
  color: var(--text);
}
.vqb-prev-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-faint);
  cursor: pointer;
}
.vqb-prev-caret:hover {
  background: var(--bg-hover);
  color: var(--text);
}
/* Segmented Table/Chart toggle */
.vqb-view-toggle {
  display: inline-flex;
  padding: 2px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
}
.vqb-view-toggle button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 11px;
  font-size: 11px;
  font-weight: 600;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.vqb-view-toggle button:hover {
  color: var(--text);
}
.vqb-view-toggle button.on {
  background: var(--bg-active);
  color: var(--accent);
}
.vqb-prev-chart {
  height: 100%;
  padding: 8px 12px;
}
.vqb-preview-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.vqb-prev-state {
  font-size: 11px;
  color: var(--accent);
}
.vqb-prev-state.err {
  color: var(--warn);
}
.vqb-prev-count {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-faint);
}
.vqb-prev-hint {
  font-size: 10px;
  color: var(--text-faint);
  font-family: var(--mono);
}
.vqb-preview .vqb-caret {
  transition: transform 0.14s;
}
.vqb-preview .vqb-caret.open {
  transform: rotate(180deg);
}
.vqb-preview-grid {
  height: 240px;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--border-soft);
}
.vqb-prev-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px;
  color: var(--danger);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
}
.vqb-prev-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-faint);
  font-size: 12px;
}
/* Sections must keep their natural height. Without this they'd flex-shrink to
   fit the canvas (a flex column) and their overflow:hidden would clip the
   content vertically instead of letting the canvas scroll. */
.vqb-canvas > * {
  flex-shrink: 0;
}

/* ---- empty state ---- */
.vqb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin: auto;
  padding: 50px 20px;
  text-align: center;
  color: var(--text-dim);
}
.vqb-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  margin-bottom: 18px;
  border-radius: 18px;
  color: var(--accent);
  background: var(--accent-soft);
}
.vqb-empty h3 {
  font-size: 17px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}
.vqb-empty p {
  font-size: 13px;
  line-height: 1.55;
  max-width: 420px;
}
.vqb-steps {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 18px 0 6px;
}
.vqb-step {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px 6px 7px;
  font-size: 12px;
  color: var(--text);
  background: var(--bg-elevated);
  border: 1px solid var(--border-soft);
  border-radius: 999px;
}
.vqb-step-n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  color: var(--on-accent);
  background: var(--accent);
}
.vqb-hint {
  color: var(--text-faint);
  font-size: 12px;
  margin-top: 10px;
}

/* ---- plain-English summary ---- */
.vqb-summary {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 11px 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: linear-gradient(180deg, var(--accent-soft), transparent 70%), var(--bg-elevated);
}
.vqb-summary-ic {
  display: inline-flex;
  margin-top: 1px;
  color: var(--accent);
  flex: none;
}
.vqb-summary p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
}

/* ---- output options bar ---- */
.vqb-options {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}
.vqb-opt {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
}
.vqb-opt.off {
  opacity: 0.45;
}
.vqb-opt input {
  accent-color: var(--accent);
  cursor: pointer;
}
.vqb-opt-eg {
  font-weight: 400;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-faint);
}
.vqb-group-note {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-dim);
}

/* ---- sections ---- */
.vqb-section {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
  overflow: hidden;
}
.vqb-plain {
  background: var(--bg-panel);
}
.vqb-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px 4px;
}
.vqb-section-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.vqb-section-head .vqb-card-btn {
  margin-left: auto;
}
.vqb-section-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 11px 14px;
  text-align: left;
  cursor: pointer;
  border: none;
  background: transparent;
}
.vqb-section-toggle:hover {
  background: var(--bg-hover);
}
.vqb-section-count {
  font-size: 10px;
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 1px 8px;
  border-radius: 999px;
  margin-left: auto;
}
.vqb-section-body {
  padding: 4px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.vqb-caret {
  display: inline-flex;
  color: var(--text-faint);
  transition: transform 0.14s;
}
.vqb-caret.open {
  transform: rotate(90deg);
}
.vqb-desc {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-faint);
  margin: 0 0 4px;
  padding: 0 14px;
}
.vqb-section-body .vqb-desc {
  padding: 0;
}
.vqb-desc code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
}
.vqb-desc em {
  font-style: normal;
  color: var(--accent);
  font-weight: 600;
}
.vqb-desc strong {
  color: var(--text);
  font-weight: 700;
}
.vqb-desc :deep(.dd-icon) {
  vertical-align: -0.15em;
}
.vqb-warn {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--warn);
  background: rgba(240, 180, 41, 0.1);
  border: 1px solid rgba(240, 180, 41, 0.3);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
}
.vqb-warn :deep(.dd-icon) {
  margin-top: 1px;
  flex: none;
}

/* ---- table cards ---- */
.vqb-section .vqb-table-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 8px 14px 14px;
}
.vqb-card {
  flex: 1 1 320px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  overflow: hidden;
  box-shadow: var(--shadow-card);
}
.vqb-card-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  color: var(--accent);
  background: var(--accent-soft);
  border-bottom: 1px solid var(--border-soft);
}
.vqb-card-name {
  font-weight: 700;
  font-size: 13px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vqb-card-count {
  font-size: 10px;
  color: var(--text-faint);
  font-family: var(--mono);
  background: var(--bg-panel);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}
.vqb-card-btn {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-faint);
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.vqb-card-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.vqb-card-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--text-faint);
  cursor: pointer;
  flex-shrink: 0;
}
.vqb-card-remove:hover {
  background: rgba(248, 113, 113, 0.15);
  color: var(--danger);
}
.vqb-card-cols {
  padding: 4px 0;
}
.vqb-no-cols {
  color: var(--text-faint);
  font-size: 11px;
  padding: 8px 12px;
  text-align: center;
}
.vqb-col {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 3px 10px;
  font-size: 12px;
}
.vqb-col:hover {
  background: var(--bg-hover);
}
.vqb-col.checked {
  background: rgba(45, 212, 191, 0.06);
}
.vqb-col-main {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
}
/* Small opt-in toggle that reveals the summarise/rename controls for one column. */
.vqb-fx {
  flex: none;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1;
  color: var(--text-faint);
  padding: 3px 7px;
  border: 1px solid var(--border-soft);
  border-radius: 5px;
  cursor: pointer;
}
.vqb-fx:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.vqb-fx.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.vqb-col-main input[type='checkbox'] {
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  cursor: pointer;
}
.vqb-col-name {
  flex: 1;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vqb-col.pk .vqb-col-name {
  font-weight: 600;
  color: var(--accent);
}
.vqb-col.fk .vqb-col-name {
  color: #7cacf8;
}
.vqb-col-ctrls {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding-left: 21px; /* line up under the column name, past the checkbox */
}
.vqb-badge {
  font-size: 8px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 3px;
  line-height: 15px;
  flex-shrink: 0;
}
.vqb-badge.pk {
  background: var(--accent-soft);
  color: var(--accent);
}
.vqb-badge.fk {
  background: rgba(91, 141, 239, 0.18);
  color: #5b8def;
}
.vqb-mini {
  font-size: 11px;
  padding: 3px 6px;
}
.vqb-alias {
  width: 74px;
}

/* ---- join rows ---- */
.vqb-join-block {
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-soft);
  background: var(--bg-elevated);
}
.vqb-join-block.disabled {
  opacity: 0.5;
}
.vqb-join-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.vqb-join-explain {
  margin: 6px 0 0;
  padding-left: 22px;
  font-size: 11px;
  color: var(--text-faint);
}
.vqb-join-check {
  accent-color: var(--accent);
  cursor: pointer;
}
.vqb-join-type {
  color: var(--accent);
  font-weight: 700;
  min-width: 76px;
}
.vqb-join-eq {
  color: var(--text-faint);
  font-weight: 700;
}

/* ---- filter / sort / group rows ---- */
.vqb-filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.vqb-where-lead,
.vqb-conn {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-faint);
  letter-spacing: 0.04em;
}
.vqb-where-lead {
  min-width: 44px;
}
.vqb-conn {
  width: 64px;
  color: var(--accent);
}
.vqb-col-select {
  flex: 1;
  min-width: 130px;
  max-width: 240px;
  font-size: 12px;
  padding: 5px 8px;
}
.vqb-op-select {
  width: 108px;
  font-size: 12px;
  padding: 5px 8px;
}
.vqb-val-input {
  flex: 1;
  min-width: 90px;
  max-width: 200px;
  font-size: 12px;
  padding: 5px 8px;
}
.vqb-raw-input {
  flex: 1;
  min-width: 200px;
  font-family: var(--mono);
  font-size: 12px;
  padding: 5px 8px;
}
.vqb-mode-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  color: var(--text-faint);
  cursor: pointer;
}
.vqb-mode-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.vqb-mode-btn.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.vqb-dir-btn {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-family: var(--mono);
}
.vqb-add-btn {
  align-self: flex-start;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 999px;
  margin-top: 2px;
}

/* ---- limit ---- */
.vqb-limit-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  font-family: var(--mono);
  min-width: 48px;
}
.vqb-limit-input {
  width: 110px;
  font-size: 12px;
  padding: 5px 8px;
}

/* ---- SQL preview ---- */
.vqb-sql-section {
  border-color: var(--border-strong);
}
.vqb-sql-opt {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.vqb-sql-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px 8px;
}
.vqb-sql-bar .vqb-card-btn {
  margin-left: auto;
}
.vqb-sql {
  margin: 6px 0 0;
  padding: 12px 14px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  background: var(--bg-input);
  border-top: 1px solid var(--border-soft);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
}
.vqb-sql code {
  color: inherit;
}
</style>
