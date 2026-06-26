<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { QueryResult, SortSpec } from '@shared/types'

interface CellPos {
  rowIndex: number
  colIndex: number
}

const props = defineProps<{
  result: QueryResult | null
  editable?: boolean
  sortable?: boolean
  edits?: Record<number, Record<string, unknown>>
  inserts?: Record<string, unknown>[]
  deletes?: number[]
  sort?: SortSpec
  selectedRow?: number | null
  selectable?: boolean
  selectedRows?: number[]
  actionLabel?: string
  highlightedCell?: CellPos | null
  highlightedCells?: CellPos[]
  /** column name -> FK target, enables inline "jump to related row" arrows. */
  fkColumns?: Record<string, { toTable: string; toColumn: string }>
}>()

const emit = defineEmits<{
  editCell: [rowIndex: number, column: string, value: unknown]
  editInsert: [index: number, column: string, value: unknown]
  removeInsert: [index: number]
  selectRow: [rowIndex: number]
  toggleSelect: [rowIndex: number]
  toggleSelectAll: []
  sort: [column: string]
  action: [row: unknown[]]
  rowContext: [rowIndex: number, e: MouseEvent, colIndex?: number]
  fkNavigate: [column: string, value: unknown]
}>()

const hasRows = computed(() => !!props.result && props.result.columns.length > 0)
const allSelected = computed(
  () =>
    !!props.result &&
    props.result.rows.length > 0 &&
    (props.selectedRows?.length ?? 0) === props.result.rows.length
)
function isSelected(r: number): boolean {
  return !!props.selectedRows?.includes(r)
}

const editing = ref<{ kind: 'data' | 'insert'; row: number; col: number } | null>(null)
const editValue = ref('')

const vAutofocus = {
  mounted: (el: HTMLInputElement) => {
    el.focus()
    el.select()
  }
}

function colName(c: number): string {
  return props.result!.columns[c].name
}
function fkOf(c: number): { toTable: string; toColumn: string } | undefined {
  return props.fkColumns?.[colName(c)]
}
function cellValue(r: number, c: number): unknown {
  const name = colName(c)
  const e = props.edits?.[r]
  if (e && name in e) return e[name]
  return props.result!.rows[r][c]
}
function insertValue(i: number, c: number): unknown {
  return props.inserts?.[i]?.[colName(c)] ?? null
}
function isDirty(r: number, c: number): boolean {
  const e = props.edits?.[r]
  return !!e && colName(c) in e
}
function isDeleted(r: number): boolean {
  return !!props.deletes?.includes(r)
}
function display(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}
function isNull(v: unknown): boolean {
  return v === null || v === undefined
}
function isFindMatch(r: number, c: number): boolean {
  return !!props.highlightedCells?.some((p) => p.rowIndex === r && p.colIndex === c)
}
function isFindCurrent(r: number, c: number): boolean {
  return props.highlightedCell?.rowIndex === r && props.highlightedCell?.colIndex === c
}

function startEdit(kind: 'data' | 'insert', r: number, c: number): void {
  if (!props.editable) return
  editing.value = { kind, row: r, col: c }
  const v = kind === 'data' ? cellValue(r, c) : insertValue(r, c)
  editValue.value = v === null || v === undefined ? '' : String(v)
}
function commitEdit(): void {
  if (!editing.value) return
  const { kind, row, col } = editing.value
  if (kind === 'data') emit('editCell', row, colName(col), editValue.value)
  else emit('editInsert', row, colName(col), editValue.value)
  editing.value = null
}
function cancelEdit(): void {
  editing.value = null
}
function isEditing(kind: 'data' | 'insert', r: number, c: number): boolean {
  return editing.value?.kind === kind && editing.value?.row === r && editing.value?.col === c
}

// When a new insert row is appended (it renders at the bottom), scroll it into
// view so it's obvious something happened.
const wrap = ref<HTMLElement>()
watch(
  () => props.inserts?.length ?? 0,
  (n, old) => {
    if (n > (old ?? 0) && wrap.value) {
      nextTick(() => {
        if (wrap.value) wrap.value.scrollTop = wrap.value.scrollHeight
      })
    }
  }
)

// Horizontal scrolling for wide grids. A plain mouse wheel only emits vertical
// ticks (and a tilt/thumb wheel's horizontal ticks are tiny with no momentum),
// so Chromium's native handling barely moves a wide table sideways. Map any
// horizontal intent — a thumb wheel's deltaX, or Shift+vertical — onto
// scrollLeft ourselves so it reaches the far edge. Pure vertical wheel is left
// to the browser, and trackpads (which already carry their own momentum in the
// event stream) still feel natural since we just apply their deltas.
function onWheel(e: WheelEvent): void {
  const el = wrap.value
  if (!el) return
  const max = el.scrollWidth - el.clientWidth
  if (max <= 0) return // nothing to scroll horizontally
  let delta = 0
  if (e.shiftKey && e.deltaX === 0) delta = e.deltaY // Shift + vertical wheel → horizontal
  else if (e.deltaX !== 0 && e.deltaY === 0) delta = e.deltaX // pure-horizontal wheel (tilt/thumb)
  else return // vertical or diagonal (trackpad) — leave to the browser
  // Normalize line/page delta modes to pixels (mouse wheels often report lines).
  if (e.deltaMode === 1) delta *= 16
  else if (e.deltaMode === 2) delta *= el.clientWidth
  const next = Math.max(0, Math.min(max, el.scrollLeft + delta))
  if (next !== el.scrollLeft) {
    el.scrollLeft = next
    e.preventDefault()
  }
}
onMounted(() => wrap.value?.addEventListener('wheel', onWheel, { passive: false }))
onBeforeUnmount(() => wrap.value?.removeEventListener('wheel', onWheel))
</script>

<template>
  <div ref="wrap" class="grid-wrap">
    <table v-if="hasRows" class="grid" :class="{ selectable }">
      <thead>
        <tr>
          <th v-if="selectable" class="selcol">
            <input type="checkbox" :checked="allSelected" title="Select all rows" @change="emit('toggleSelectAll')" />
          </th>
          <th class="rownum">#</th>
          <th v-if="actionLabel" class="actcol"></th>
          <th
            v-for="(col, i) in result!.columns"
            :key="i"
            :class="{ sortable }"
            @click="sortable && emit('sort', col.name)"
          >
            <span>{{ col.name }}</span>
            <span v-if="sort?.column === col.name" class="sort-ind">{{ sort.dir === 'asc' ? '▲' : '▼' }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <!-- existing rows -->
        <tr
          v-for="(row, r) in result!.rows"
          :key="r"
          :class="{ selected: selectedRow === r, 'multi-selected': isSelected(r), deleted: isDeleted(r) }"
          @click="emit('selectRow', r)"
          @contextmenu.prevent="emit('rowContext', r, $event)"
        >
          <td v-if="selectable" class="selcol" @click.stop>
            <input type="checkbox" :checked="isSelected(r)" @change="emit('toggleSelect', r)" />
          </td>
          <td class="rownum">{{ r + 1 }}</td>
          <td v-if="actionLabel" class="actcol">
            <button class="row-act" @click.stop="emit('action', row as unknown[])">{{ actionLabel }}</button>
          </td>
          <td
            v-for="(_, c) in row"
            :key="c"
            :class="{ null: isNull(cellValue(r, c)), dirty: isDirty(r, c), editing: isEditing('data', r, c), 'find-match': isFindMatch(r, c), 'find-current': isFindCurrent(r, c), fk: !!fkOf(c) }"
            :title="fkOf(c) && !isNull(cellValue(r, c)) ? `Go to ${fkOf(c)!.toTable} where ${fkOf(c)!.toColumn} = ${display(cellValue(r, c))}` : display(cellValue(r, c))"
            @dblclick="startEdit('data', r, c)"
            @contextmenu.prevent.stop="emit('rowContext', r, $event, c)"
          >
            <input
              v-if="isEditing('data', r, c)"
              v-autofocus
              class="cell-input"
              v-model="editValue"
              @keydown.enter.prevent="commitEdit"
              @keydown.esc.prevent="cancelEdit"
              @blur="commitEdit"
              @click.stop
            />
            <template v-else>
              <span class="cell-text">{{ display(cellValue(r, c)) }}</span>
              <button
                v-if="fkOf(c) && !isNull(cellValue(r, c))"
                class="fk-jump"
                title="Go to related row"
                @click.stop="emit('fkNavigate', colName(c), cellValue(r, c))"
              >→</button>
            </template>
          </td>
        </tr>

        <!-- pending new rows -->
        <tr v-for="(ins, i) in inserts" :key="'ins-' + i" class="insert-row">
          <td v-if="selectable" class="selcol"></td>
          <td class="rownum">
            <button class="remove-insert" title="Remove" @click.stop="emit('removeInsert', i)">✕</button>
          </td>
          <td v-if="actionLabel" class="actcol"></td>
          <td
            v-for="(col, c) in result!.columns"
            :key="c"
            :class="{ null: isNull(insertValue(i, c)), editing: isEditing('insert', i, c) }"
            @dblclick="startEdit('insert', i, c)"
          >
            <input
              v-if="isEditing('insert', i, c)"
              v-autofocus
              class="cell-input"
              v-model="editValue"
              @keydown.enter.prevent="commitEdit"
              @keydown.esc.prevent="cancelEdit"
              @blur="commitEdit"
              @click.stop
            />
            <template v-else>{{ display(insertValue(i, c)) }}</template>
          </td>
        </tr>

        <tr v-if="result!.rows.length === 0 && (!inserts || inserts.length === 0)">
          <td v-if="selectable" class="selcol"></td>
          <td class="rownum"></td>
          <td :colspan="result!.columns.length + (actionLabel ? 1 : 0)" class="empty-cell">No rows</td>
        </tr>
      </tbody>
    </table>

    <div v-else-if="result" class="message">
      <p>
        Statement executed.
        <template v-if="result.affectedRows !== undefined">
          {{ result.affectedRows }} row(s) affected.
        </template>
      </p>
    </div>

    <div v-else class="placeholder">
      <p>Run a query or open a table to see results here.</p>
    </div>
  </div>
</template>

<style scoped>
.grid-wrap {
  height: 100%;
  overflow: auto;
  background: var(--bg-panel);
}
.grid {
  border-collapse: separate;
  border-spacing: 0;
  width: max-content;
  min-width: 100%;
  font-size: 12px;
}
thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-elevated);
  text-align: left;
  font-weight: 700;
  font-size: 11.5px;
  color: var(--text-dim);
  padding: 11px 14px;
  border-bottom: 1px solid var(--border-strong);
  white-space: nowrap;
  user-select: none;
}
/* Keep data columns wide enough that short values never clip the header name. */
thead th:not(.selcol):not(.rownum):not(.actcol),
tbody td:not(.selcol):not(.rownum):not(.actcol) {
  min-width: 90px;
}
thead th.sortable {
  cursor: pointer;
}
thead th.sortable:hover {
  color: var(--text);
}
.sort-ind {
  margin-left: 5px;
  color: var(--accent);
  font-size: 9px;
}
tbody td {
  padding: 7px 14px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--mono);
  font-size: 12.5px;
}
tbody tr:hover td {
  background: var(--bg-hover);
}
tbody tr.selected td {
  background: var(--accent-soft);
}
tbody tr.multi-selected td {
  background: var(--accent-soft);
}
.selcol {
  position: sticky;
  left: 0;
  width: 36px;
  min-width: 36px;
  text-align: center;
  padding: 7px 8px;
  background: var(--bg-elevated);
}
/* The sticky checkbox/# columns must stay opaque — otherwise data cells (e.g.
   an italic NULL) show through them while scrolling horizontally. Win over the
   semi-transparent hover/selected/insert row backgrounds. */
.grid tbody td.selcol,
.grid tbody td.rownum {
  background: var(--bg-elevated);
  z-index: 1;
}
thead .selcol {
  z-index: 3;
}
tbody .selcol {
  z-index: 1;
}
.selcol input {
  cursor: pointer;
  accent-color: var(--accent);
  vertical-align: middle;
}
/* When the checkbox column is present, the row-number column sits next to it. */
.grid.selectable .rownum {
  left: 36px;
}
tbody tr.deleted td {
  background: rgba(248, 113, 113, 0.16) !important;
  color: var(--danger);
  text-decoration: line-through;
}
tbody tr.insert-row td {
  background: rgba(74, 222, 128, 0.1);
}
td.dirty {
  background: rgba(240, 180, 41, 0.18) !important;
  color: var(--warn);
}
/* Foreign-key cells: value reads as a link, arrow jumps to the related row. */
td.fk {
  position: relative;
}
td.fk:not(.null) .cell-text {
  color: var(--accent);
}
.fk-jump {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  opacity: 0;
  color: var(--accent);
  font-weight: 700;
  font-size: 12px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
}
td.fk:hover .fk-jump {
  opacity: 1;
}
.fk-jump:hover {
  background: var(--accent-soft);
}
td.editing {
  padding: 0;
}
.cell-input {
  width: 100%;
  min-width: 80px;
  border: 1px solid var(--accent);
  background: var(--bg-input);
  color: var(--text);
  padding: 4px 11px;
  font-family: var(--mono);
  font-size: 12px;
  outline: none;
}
.rownum {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-elevated);
  color: var(--text-faint);
  text-align: center;
  font-family: var(--mono);
  user-select: none;
  min-width: 48px;
  border-right: 1px solid var(--border);
}
thead .rownum {
  z-index: 3;
}
.remove-insert {
  color: var(--danger);
  font-size: 11px;
  width: 18px;
  height: 18px;
  border-radius: 3px;
}
.remove-insert:hover {
  background: rgba(248, 113, 113, 0.18);
}
td.null {
  color: var(--text-faint);
  font-style: italic;
}
.empty-cell {
  text-align: center;
  color: var(--text-dim);
  padding: 20px;
}
.actcol {
  width: 1%;
  white-space: nowrap;
}
.row-act {
  color: var(--danger);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid transparent;
}
.row-act:hover {
  background: rgba(248, 113, 113, 0.15);
  border-color: var(--danger);
}
td.find-match {
  background: rgba(240, 180, 41, 0.22) !important;
}
td.find-current {
  background: rgba(240, 180, 41, 0.5) !important;
  outline: 2px solid var(--warn);
  outline-offset: -2px;
}
.message,
.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-dim);
}
</style>
