<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import type { ColumnMeta, ErModel, ErRelation } from '@shared/types'
// Self-import: this component renders itself for nested (deeper) records.
import RelatedNode from './RelatedNode.vue'

const props = withDefaults(
  defineProps<{
    connId: string
    er: ErModel
    table: string
    /** Column identifying this record (usually the PK). */
    column: string
    value: unknown
    label?: string
    depth?: number
    /** Keys (`table#value`) of records above this one — used to break cycles. */
    ancestors?: string[]
    /** Whether the node body is expanded on first render. */
    defaultOpen?: boolean
  }>(),
  { depth: 0, ancestors: () => [], defaultOpen: false }
)

const MAX_DEPTH = 6
const ROW_CAP = 50

const selfKey = computed(() => `${props.table}#${String(props.value)}`)
const open = ref(!!props.defaultOpen)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const columns = ref<ColumnMeta[]>([])
const row = ref<unknown[] | null>(null)

interface Group {
  rel: ErRelation
  loading: boolean
  error: string
  cols: ColumnMeta[]
  rows: unknown[][]
  capped: boolean
}
const groups = reactive<Group[]>([])
// Which nested records are expanded, keyed by a stable string.
const expanded = reactive<Record<string, boolean>>({})

function cellByName(cols: ColumnMeta[], r: unknown[], name: string): unknown {
  const i = cols.findIndex((c) => c.name === name)
  return i >= 0 ? r[i] : undefined
}
function display(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}
function pkColumnFor(table: string): string | undefined {
  const t = props.er.tables.find((x) => x.name === table)
  return t?.columns.find((c) => c.isPrimaryKey)?.name
}
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

// FK columns on this table -> the relation they point through (parent records).
const outgoing = computed(() => {
  const map = new Map<string, ErRelation>()
  for (const r of props.er.relations) if (r.fromTable === props.table) map.set(r.fromColumn, r)
  return map
})
// Relations pointing AT this table (child tables that reference this record).
const incoming = computed(() =>
  props.er.relations.filter((r) => r.toTable === props.table)
)

async function ensureLoaded(): Promise<void> {
  if (loaded.value || loading.value) return
  loading.value = true
  error.value = ''
  try {
    const res = await window.api.db.tableData(
      props.connId,
      { name: props.table, type: 'table' },
      {
        limit: 1,
        offset: 0,
        filters: [
          { column: props.column, op: '=', value: props.value == null ? '' : String(props.value) }
        ]
      }
    )
    columns.value = res.columns
    row.value = res.rows[0] ?? null
    if (!row.value) {
      error.value = 'No record matches this reference.'
      return
    }
    // Eagerly load every "referenced by" group so counts show at a glance.
    groups.splice(0, groups.length)
    for (const rel of incoming.value) {
      const g: Group = { rel, loading: true, error: '', cols: [], rows: [], capped: false }
      groups.push(g)
    }
    await Promise.all(groups.map(loadGroup))
    loaded.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadGroup(g: Group): Promise<void> {
  const parentVal = row.value ? cellByName(columns.value, row.value, g.rel.toColumn) : undefined
  g.loading = true
  g.error = ''
  try {
    const res = await window.api.db.tableData(
      props.connId,
      { name: g.rel.fromTable, type: 'table' },
      {
        limit: ROW_CAP + 1,
        offset: 0,
        filters: [
          { column: g.rel.fromColumn, op: '=', value: parentVal == null ? '' : String(parentVal) }
        ]
      }
    )
    g.cols = res.columns
    g.capped = res.rows.length > ROW_CAP
    g.rows = res.rows.slice(0, ROW_CAP)
  } catch (e) {
    g.error = e instanceof Error ? e.message : String(e)
  } finally {
    g.loading = false
  }
}

function toggle(): void {
  open.value = !open.value
  if (open.value) void ensureLoaded()
}

const canDescend = computed(() => (props.depth ?? 0) < MAX_DEPTH)
function isCycle(key: string): boolean {
  return props.ancestors.includes(key)
}
function toggleExpand(key: string): void {
  expanded[key] = !expanded[key]
}

// Root node auto-expands and loads.
watch(
  () => open.value,
  (v) => {
    if (v) void ensureLoaded()
  },
  { immediate: true }
)
</script>

<template>
  <div class="node" :class="{ root: depth === 0 }">
    <button class="node-head" @click="toggle">
      <span class="caret" :class="{ open }">▸</span>
      <span class="node-table">{{ table }}</span>
      <span class="node-label">{{ label ?? recordLabel(table, columns, row ?? []) }}</span>
    </button>

    <div v-if="open" class="node-body">
      <div v-if="loading" class="state">Loading…</div>
      <div v-else-if="error" class="state err">{{ error }}</div>

      <template v-else-if="row">
        <!-- Parents: FK columns pointing at other records -->
        <div v-if="[...outgoing.keys()].some((c) => cellByName(columns, row!, c) != null)" class="sect">
          <h4>Parents</h4>
          <template v-for="col in columns" :key="col.name">
            <div
              v-if="outgoing.has(col.name) && cellByName(columns, row, col.name) != null"
              class="parent"
            >
              <template v-if="canDescend && !isCycle(`${outgoing.get(col.name)!.toTable}#${String(cellByName(columns, row, col.name))}`)">
                <button class="rec-toggle" @click="toggleExpand(`p:${col.name}`)">
                  <span class="caret sm" :class="{ open: expanded[`p:${col.name}`] }">▸</span>
                  <span class="via">{{ col.name }} →</span>
                  <span class="to">{{ outgoing.get(col.name)!.toTable }} #{{ display(cellByName(columns, row, col.name)) }}</span>
                </button>
                <div v-if="expanded[`p:${col.name}`]" class="nested">
                  <RelatedNode
                    :conn-id="connId"
                    :er="er"
                    :table="outgoing.get(col.name)!.toTable"
                    :column="outgoing.get(col.name)!.toColumn"
                    :value="cellByName(columns, row, col.name)"
                    :depth="(depth ?? 0) + 1"
                    :ancestors="[...ancestors, selfKey]"
                    :default-open="true"
                  />
                </div>
              </template>
              <span v-else class="parent-flat">
                <span class="via">{{ col.name }} →</span>
                <span class="to">{{ outgoing.get(col.name)!.toTable }} #{{ display(cellByName(columns, row, col.name)) }}</span>
              </span>
            </div>
          </template>
        </div>

        <!-- Referenced by: child tables -->
        <div v-if="groups.length" class="sect">
          <h4>Referenced by</h4>
          <div v-for="(g, gi) in groups" :key="gi" class="group">
            <button class="group-head" @click="toggleExpand(`g:${gi}`)">
              <span class="caret sm" :class="{ open: expanded[`g:${gi}`] }">▸</span>
              <span class="grp-name">{{ g.rel.fromTable }}</span>
              <span class="grp-via">via {{ g.rel.fromColumn }}</span>
              <span v-if="g.loading" class="grp-count muted">…</span>
              <span v-else class="grp-count">{{ g.rows.length }}{{ g.capped ? '+' : '' }}</span>
            </button>
            <div v-if="expanded[`g:${gi}`]" class="group-body">
              <div v-if="g.error" class="state sm err">{{ g.error }}</div>
              <div v-else-if="!g.rows.length" class="state sm">No related rows.</div>
              <template v-for="(cr, ri) in g.rows" :key="ri">
                <template v-if="canDescend && !isCycle(`${g.rel.fromTable}#${String(cellByName(g.cols, cr, pkColumnFor(g.rel.fromTable) ?? g.rel.fromColumn))}`)">
                  <RelatedNode
                    :conn-id="connId"
                    :er="er"
                    :table="g.rel.fromTable"
                    :column="pkColumnFor(g.rel.fromTable) ?? g.rel.fromColumn"
                    :value="cellByName(g.cols, cr, pkColumnFor(g.rel.fromTable) ?? g.rel.fromColumn)"
                    :label="recordLabel(g.rel.fromTable, g.cols, cr)"
                    :depth="(depth ?? 0) + 1"
                    :ancestors="[...ancestors, selfKey]"
                  />
                </template>
                <span v-else class="child-flat">{{ recordLabel(g.rel.fromTable, g.cols, cr) }}</span>
              </template>
            </div>
          </div>
        </div>

        <div v-if="!groups.length && ![...outgoing.keys()].some((c) => cellByName(columns, row!, c) != null)" class="state sm">
          No related records.
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.node {
  border-left: 1px solid var(--border);
  margin-left: 2px;
}
.node.root {
  border-left: none;
  margin-left: 0;
}
.node-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  font-size: 13px;
  color: var(--text);
  text-align: left;
  border-radius: var(--radius-sm);
}
.node-head:hover {
  background: var(--bg-hover);
}
.node.root > .node-head {
  font-size: 15px;
  font-weight: 600;
  padding: 8px 10px;
}
.caret {
  color: var(--text-faint);
  transition: transform 0.12s ease;
  display: inline-block;
  flex: none;
}
.caret.sm {
  font-size: 10px;
}
.caret.open {
  transform: rotate(90deg);
}
.node-table {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--accent);
  font-weight: 700;
  flex: none;
}
.node-label {
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-body {
  padding: 2px 0 4px 18px;
}
.state {
  color: var(--text-dim);
  font-size: 13px;
  padding: 10px 4px;
}
.state.sm {
  font-size: 12px;
  padding: 4px;
}
.state.err {
  color: var(--danger);
}
.sect {
  margin: 4px 0 8px;
}
.sect h4 {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-faint);
  margin: 6px 0 4px;
}
.parent,
.group {
  margin-bottom: 2px;
}
.rec-toggle,
.group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 4px 8px;
  font-size: 12.5px;
  color: var(--text);
  text-align: left;
  border-radius: var(--radius-sm);
}
.rec-toggle:hover,
.group-head:hover {
  background: var(--bg-hover);
}
.via {
  color: var(--text-faint);
  font-size: 11.5px;
  flex: none;
}
.to {
  font-family: var(--mono);
  color: var(--accent);
}
.parent-flat,
.child-flat {
  display: inline-flex;
  gap: 7px;
  padding: 4px 8px 4px 23px;
  font-size: 12.5px;
  font-family: var(--mono);
  color: var(--text-dim);
}
.grp-name {
  font-weight: 600;
}
.grp-via {
  color: var(--text-faint);
  font-size: 11.5px;
}
.grp-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
}
.grp-count.muted {
  color: var(--text-faint);
}
.group-body,
.nested {
  padding-left: 16px;
}
</style>
