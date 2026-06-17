<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import type { ColumnMeta, ErModel, ErRelation } from '@shared/types'
import { useTabs, type Tab, type ExplorerFocus } from '../stores/tabs'
import { useWorkspace } from '../stores/workspace'

const props = defineProps<{ tab: Tab }>()
const tabsStore = useTabs()
const ws = useWorkspace()

const focus = computed<ExplorerFocus | null>(() => {
  const s = props.tab.explorerStack
  const i = props.tab.explorerIndex ?? 0
  return s && s[i] ? s[i] : null
})
const trail = computed(() => props.tab.explorerStack ?? [])
const trailIndex = computed(() => props.tab.explorerIndex ?? 0)

const loading = ref(false)
const error = ref('')
const columns = ref<ColumnMeta[]>([])
const row = ref<unknown[] | null>(null)
const er = ref<ErModel | null>(null)

interface ChildState {
  open: boolean
  loading: boolean
  loaded: boolean
  error: string
  cols: ColumnMeta[]
  rows: unknown[][]
  capped: boolean
}
const children = reactive<Record<number, ChildState>>({})

function cellByName(cols: ColumnMeta[], r: unknown[], name: string): unknown {
  const i = cols.findIndex((c) => c.name === name)
  return i >= 0 ? r[i] : undefined
}
function display(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}
function pkColumnFor(table: string): string | undefined {
  const t = er.value?.tables.find((x) => x.name === table)
  return t?.columns.find((c) => c.isPrimaryKey)?.name
}
/** A short, human label for a row (PK plus a guessed name column). */
function recordLabel(table: string, cols: ColumnMeta[], r: unknown[]): string {
  const pkCol = pkColumnFor(table)
  const pk = pkCol ? cellByName(cols, r, pkCol) : undefined
  const nameCol = cols.find((c) => /(^|_)(name|title|label|email|slug|code)$/i.test(c.name))
  const nameVal = nameCol ? cellByName(cols, r, nameCol.name) : undefined
  const parts: string[] = []
  if (pk !== undefined && pk !== null) parts.push(`#${String(pk)}`)
  if (nameVal !== undefined && nameVal !== null && String(nameVal) !== String(pk)) {
    parts.push(String(nameVal))
  }
  return parts.join(' · ') || '(row)'
}

// FK columns of the focused table: column -> relation it points through.
const outgoing = computed(() => {
  const map = new Map<string, ErRelation>()
  const t = focus.value?.table
  for (const r of er.value?.relations ?? []) {
    if (r.fromTable === t) map.set(r.fromColumn, r)
  }
  return map
})
// Relations that point AT the focused table (child tables that reference it).
const incoming = computed(() =>
  (er.value?.relations ?? []).filter((r) => r.toTable === focus.value?.table)
)

async function load(): Promise<void> {
  const f = focus.value
  if (!f) return
  const connId = props.tab.connectionId
  loading.value = true
  error.value = ''
  row.value = null
  for (const k of Object.keys(children)) delete children[Number(k)]
  try {
    er.value = (await ws.loadErModel(connId).catch(() => null)) ?? null
    const res = await window.api.db.tableData(
      connId,
      { name: f.table, type: 'table' },
      {
        limit: 1,
        offset: 0,
        filters: [{ column: f.column, op: '=', value: f.value == null ? '' : String(f.value) }]
      }
    )
    columns.value = res.columns
    row.value = res.rows[0] ?? null
    if (!row.value) error.value = 'No record matches this reference.'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
watch(focus, load, { immediate: true })

function openParent(rel: ErRelation, value: unknown): void {
  if (value === null || value === undefined) return
  tabsStore.navigateExplorer(props.tab, {
    table: rel.toTable,
    column: rel.toColumn,
    value,
    label: `${rel.toTable} #${String(value)}`
  })
}

function openChild(rel: ErRelation, cols: ColumnMeta[], childRow: unknown[]): void {
  const pkCol = pkColumnFor(rel.fromTable) ?? rel.fromColumn
  const value = cellByName(cols, childRow, pkCol)
  tabsStore.navigateExplorer(props.tab, {
    table: rel.fromTable,
    column: pkCol,
    value,
    label: recordLabel(rel.fromTable, cols, childRow) + ` — ${rel.fromTable}`
  })
}

async function toggleChild(i: number, rel: ErRelation): Promise<void> {
  let st = children[i]
  if (!st) {
    st = children[i] = {
      open: false,
      loading: false,
      loaded: false,
      error: '',
      cols: [],
      rows: [],
      capped: false
    }
  }
  st.open = !st.open
  if (!st.open || st.loaded || st.loading) return
  const parentVal = row.value ? cellByName(columns.value, row.value, rel.toColumn) : undefined
  st.loading = true
  try {
    const res = await window.api.db.tableData(
      props.tab.connectionId,
      { name: rel.fromTable, type: 'table' },
      {
        limit: 51,
        offset: 0,
        filters: [
          { column: rel.fromColumn, op: '=', value: parentVal == null ? '' : String(parentVal) }
        ]
      }
    )
    st.cols = res.columns
    st.capped = res.rows.length > 50
    st.rows = res.rows.slice(0, 50)
    st.loaded = true
  } catch (e) {
    st.error = e instanceof Error ? e.message : String(e)
  } finally {
    st.loading = false
  }
}
</script>

<template>
  <div class="explorer">
    <!-- breadcrumb trail -->
    <nav class="trail">
      <template v-for="(f, i) in trail" :key="i">
        <span v-if="i" class="sep">›</span>
        <button
          class="crumb"
          :class="{ on: i === trailIndex }"
          :title="f.table"
          @click="tabsStore.explorerGoTo(tab, i)"
        >{{ f.label ?? `${f.table} #${String(f.value)}` }}</button>
      </template>
    </nav>

    <div class="body">
      <div v-if="loading" class="state">Loading record…</div>
      <div v-else-if="error" class="state err">{{ error }}</div>

      <template v-else-if="row">
        <div class="rec-head">
          <span class="rec-table">{{ focus?.table }}</span>
          <span class="rec-label">{{ recordLabel(focus!.table, columns, row) }}</span>
        </div>

        <!-- fields; FK columns are clickable -->
        <div class="fields">
          <div
            v-for="(col, i) in columns"
            :key="col.name"
            class="field"
            :class="{ fk: outgoing.has(col.name) }"
          >
            <div class="f-label">
              {{ col.name }}
              <span v-if="outgoing.has(col.name)" class="fk-tag" :title="`→ ${outgoing.get(col.name)!.toTable}.${outgoing.get(col.name)!.toColumn}`">FK</span>
            </div>
            <div class="f-value">
              <button
                v-if="outgoing.has(col.name) && row[i] !== null && row[i] !== undefined"
                class="fk-link"
                :title="`Open ${outgoing.get(col.name)!.toTable} record`"
                @click="openParent(outgoing.get(col.name)!, row[i])"
              >{{ display(row[i]) }} →</button>
              <span v-else class="val" :class="{ nul: row[i] === null || row[i] === undefined }">
                {{ row[i] === null || row[i] === undefined ? 'NULL' : display(row[i]) }}
              </span>
            </div>
          </div>
        </div>

        <!-- referenced by: child tables pointing at this record -->
        <div v-if="incoming.length" class="related">
          <h3>Referenced by</h3>
          <div v-for="(rel, i) in incoming" :key="i" class="rel">
            <button class="rel-head" @click="toggleChild(i, rel)">
              <span class="caret" :class="{ open: children[i]?.open }">▸</span>
              <span class="rel-name">{{ rel.fromTable }}</span>
              <span class="rel-via">via {{ rel.fromColumn }}</span>
              <span v-if="children[i]?.loaded" class="rel-count">
                {{ children[i].rows.length }}{{ children[i].capped ? '+' : '' }}
              </span>
            </button>
            <div v-if="children[i]?.open" class="rel-body">
              <div v-if="children[i].loading" class="state sm">Loading…</div>
              <div v-else-if="children[i].error" class="state sm err">{{ children[i].error }}</div>
              <div v-else-if="!children[i].rows.length" class="state sm">No related rows.</div>
              <button
                v-for="(cr, ri) in children[i].rows"
                :key="ri"
                class="child"
                @click="openChild(rel, children[i].cols, cr)"
              >
                <span class="child-label">{{ recordLabel(rel.fromTable, children[i].cols, cr) }}</span>
                <span class="child-go">→</span>
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.explorer {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
}
.trail {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  min-height: 38px;
}
.crumb {
  font-size: 12px;
  color: var(--text-dim);
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crumb:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.crumb.on {
  color: var(--text);
  background: var(--accent-soft);
  font-weight: 600;
}
.sep {
  color: var(--text-faint);
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
}
.state {
  color: var(--text-dim);
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}
.state.sm {
  padding: 8px 0;
  font-size: 12px;
  text-align: left;
}
.state.err {
  color: var(--danger);
}
.rec-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
}
.rec-table {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--accent);
  font-weight: 700;
}
.rec-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.fields {
  display: grid;
  grid-template-columns: minmax(140px, 220px) 1fr;
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.field {
  display: contents;
}
.f-label,
.f-value {
  background: var(--bg-panel);
  padding: 8px 12px;
  font-size: 12.5px;
}
.f-label {
  color: var(--text-dim);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.field.fk .f-label {
  color: var(--text);
}
.fk-tag {
  font-size: 9px;
  font-weight: 700;
  background: var(--accent-soft);
  color: var(--accent);
  padding: 1px 4px;
  border-radius: 3px;
}
.f-value {
  font-family: var(--mono);
  color: var(--text);
  word-break: break-word;
}
.val.nul {
  color: var(--text-faint);
  font-style: italic;
}
.fk-link {
  font-family: var(--mono);
  color: var(--accent);
  font-weight: 600;
}
.fk-link:hover {
  text-decoration: underline;
}
.related {
  margin-top: 22px;
}
.related h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-faint);
  margin-bottom: 8px;
}
.rel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 8px;
  overflow: hidden;
}
.rel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  font-size: 13px;
  color: var(--text);
  background: var(--bg-panel);
}
.rel-head:hover {
  background: var(--bg-hover);
}
.caret {
  color: var(--text-faint);
  transition: transform 0.12s ease;
  display: inline-block;
}
.caret.open {
  transform: rotate(90deg);
}
.rel-name {
  font-weight: 600;
}
.rel-via {
  color: var(--text-faint);
  font-size: 11.5px;
}
.rel-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
}
.rel-body {
  border-top: 1px solid var(--border);
  padding: 6px 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.child {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text);
  text-align: left;
}
.child:hover {
  background: var(--accent-soft);
}
.child-label {
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.child-go {
  color: var(--accent);
  flex: none;
}
</style>
