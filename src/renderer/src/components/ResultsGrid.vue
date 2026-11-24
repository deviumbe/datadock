<script setup lang="ts">
import Icon from './Icon.vue'
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount, useId } from 'vue'
import { openContextMenuAt } from '../lib/rows'
import { dialogOpen } from '../lib/dialog'
import type { QueryResult, SortSpec } from '@shared/types'

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
  viewCell: [rowIndex: number, colIndex: number]
  headerContext: [column: string, e: MouseEvent]
  fkNavigate: [column: string, value: unknown]
}>()

// A cell worth opening in the value viewer rather than the inline editor: JSON,
// or anything too long to read in the truncated grid cell.
function isExpandable(v: unknown): boolean {
  if (typeof v !== 'string') return false
  if (v.length > 200) return true
  const s = v.trim()
  return s.length > 1 && (s[0] === '{' || s[0] === '[')
}
function onCellDblClick(r: number, c: number): void {
  if (isExpandable(cellValue(r, c))) emit('viewCell', r, c)
  else startEdit('data', r, c)
}

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
  table.value?.focus({ preventScroll: true })
}
function commitFromKeyboard(): void {
  commitEdit()
  table.value?.focus({ preventScroll: true })
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
        cursor.value = { r: lastCursorRow.value, c: 0 }
      })
    }
  }
)

// Horizontal wheel-scrolling for wide grids is handled app-wide by
// installHorizontalWheel() (see lib/hscroll.ts), which scrolls the nearest
// horizontally-scrollable ancestor — no per-grid handler needed here.

// ---- rectangular cell selection (drag to select a block, ⌘C / ⌘⇧C to copy) --
const cellSel = ref<{ a: { r: number; c: number }; f: { r: number; c: number } } | null>(null)
const dragging = ref(false)
let anchorCell: { r: number; c: number } | null = null // persists for shift-extend
let dragAnchor: { r: number; c: number } | null = null // active drag only
let dragged = false

function onCellMouseDown(r: number, c: number, e: MouseEvent): void {
  if (e.button !== 0 || isEditing('data', r, c)) return
  cursor.value = { r, c }
  if (e.shiftKey && anchorCell) {
    // Shift-click extends the block from the last anchor cell.
    cellSel.value = { a: anchorCell, f: { r, c } }
    dragged = true
    e.preventDefault()
    return
  }
  anchorCell = { r, c }
  dragAnchor = { r, c }
  dragged = false
}
function onCellMouseEnter(r: number, c: number): void {
  if (!dragAnchor) return
  if (r === dragAnchor.r && c === dragAnchor.c && !cellSel.value) return
  dragged = true
  dragging.value = true
  cellSel.value = { a: dragAnchor, f: { r, c } }
}
function endDrag(): void {
  dragAnchor = null
  dragging.value = false
}
function onRowClick(r: number): void {
  // A click that concluded a drag/shift-extend must not collapse the block.
  if (dragged) {
    dragged = false
    return
  }
  cellSel.value = null
  emit('selectRow', r)
}
function selBounds(): { r0: number; r1: number; c0: number; c1: number } | null {
  const s = cellSel.value
  if (!s) return null
  return {
    r0: Math.min(s.a.r, s.f.r),
    r1: Math.max(s.a.r, s.f.r),
    c0: Math.min(s.a.c, s.f.c),
    c1: Math.max(s.a.c, s.f.c)
  }
}
function inCellSel(r: number, c: number): boolean {
  const b = selBounds()
  return !!b && r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1
}
function cellText(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}
async function copyBlock(format: 'tsv' | 'md'): Promise<void> {
  const b = selBounds()
  if (!b || !props.result) return
  const headers: string[] = []
  for (let c = b.c0; c <= b.c1; c++) headers.push(colName(c))
  const rows: string[][] = []
  for (let r = b.r0; r <= b.r1; r++) {
    const row: string[] = []
    for (let c = b.c0; c <= b.c1; c++) row.push(cellText(cellValue(r, c)))
    rows.push(row)
  }
  let text: string
  if (format === 'md') {
    const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
    const line = (cells: string[]): string => `| ${cells.map(esc).join(' | ')} |`
    text = [line(headers), `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n')
  } else {
    text = rows.map((row) => row.map((v) => v.replace(/\t/g, ' ')).join('\t')).join('\n')
  }
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard unavailable */
  }
}
function onKeyDown(e: KeyboardEvent): void {
  if (!cellSel.value || editing.value || dialogOpen()) return
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    void copyBlock(e.shiftKey ? 'md' : 'tsv')
  } else if (e.key === 'Escape') {
    cellSel.value = null
  }
}
onMounted(() => {
  window.addEventListener('mouseup', endDrag)
  window.addEventListener('keydown', onKeyDown)
})
onBeforeUnmount(() => {
  window.removeEventListener('mouseup', endDrag)
  window.removeEventListener('keydown', onKeyDown)
})

// ---- keyboard cursor --------------------------------------------------------
// The table is one tab stop; the cursor cell is exposed through
// aria-activedescendant, which survives rows being recycled by virtualization.
// Row -1 is the header.
const uid = useId()
const table = ref<HTMLTableElement>()
const cursor = ref<{ r: number; c: number } | null>(null)
const tableFocused = ref(false)
const cellId = (r: number, c: number): string => `${uid}-${r}-${c}`
const isCursor = (r: number, c: number): boolean =>
  tableFocused.value && cursor.value?.r === r && cursor.value.c === c

function onTableFocus(): void {
  tableFocused.value = true
  if (!cursor.value) cursor.value = { r: totalRows.value ? winFirstVisible() : -1, c: 0 }
}
function winFirstVisible(): number {
  return Math.min(totalRows.value - 1, Math.ceil(scrollTop.value / rowH.value))
}

const lastCursorRow = computed(() => totalRows.value + (props.inserts?.length ?? 0) - 1)

async function moveCursor(r: number, c: number, extend: boolean): Promise<void> {
  const colCount = props.result!.columns.length
  const next = {
    r: Math.max(-1, Math.min(lastCursorRow.value, r)),
    c: Math.max(0, Math.min(colCount - 1, c))
  }
  const inData = (row: number): boolean => row >= 0 && row < totalRows.value
  if (extend && inData(next.r) && cursor.value && inData(cursor.value.r)) {
    const a = cellSel.value?.a ?? cursor.value
    anchorCell = a
    cellSel.value = { a, f: next }
  } else {
    cellSel.value = null
    if (inData(next.r)) anchorCell = next
  }
  cursor.value = next
  if (next.r >= 0) scrollRowIntoView(next.r)
  await nextTick()
  scrollCellIntoView(next.r, next.c)
}
function scrollRowIntoView(r: number): void {
  const el = wrap.value
  if (!el) return
  const head = table.value?.tHead?.offsetHeight ?? 0
  const top = r * rowH.value
  if (top < el.scrollTop) el.scrollTop = top
  else if (top + rowH.value > el.scrollTop + el.clientHeight - head)
    el.scrollTop = top + rowH.value - el.clientHeight + head
  scrollTop.value = el.scrollTop
}
function scrollCellIntoView(r: number, c: number): void {
  const el = wrap.value
  const cell = document.getElementById(cellId(r, c))
  if (!el || !cell) return
  const box = el.getBoundingClientRect()
  const r0 = cell.getBoundingClientRect()
  const frozen = document.getElementById(cellId(-1, 0))
  const left = c === 0 ? box.left : (frozen?.getBoundingClientRect().right ?? box.left)
  if (c === 0) el.scrollLeft = 0
  else if (r0.left < left) el.scrollLeft -= left - r0.left
  else if (r0.right > box.left + el.clientWidth) el.scrollLeft += r0.right - (box.left + el.clientWidth)
}

function activateCell(r: number, c: number): void {
  if (r >= totalRows.value) {
    startEdit('insert', r - totalRows.value, c)
    return
  }
  if (props.editable && !isExpandable(cellValue(r, c))) startEdit('data', r, c)
  else if (isExpandable(cellValue(r, c))) emit('viewCell', r, c)
  else emit('selectRow', r)
}

function onGridKeydown(e: KeyboardEvent): void {
  if (e.target !== table.value || !cursor.value || !props.result) return
  const { r, c } = cursor.value
  const mod = e.metaKey || e.ctrlKey
  const page = Math.max(1, Math.floor(viewportH.value / rowH.value) - 2)
  const lastRow = lastCursorRow.value
  const isInsert = r >= totalRows.value
  const lastCol = props.result.columns.length - 1
  switch (e.key) {
    case 'ArrowDown':
      void moveCursor(mod ? lastRow : r + 1, c, e.shiftKey)
      break
    case 'ArrowUp':
      void moveCursor(mod ? 0 : r - 1, c, e.shiftKey)
      break
    case 'ArrowRight':
      void moveCursor(r, mod ? lastCol : c + 1, e.shiftKey)
      break
    case 'ArrowLeft':
      void moveCursor(r, mod ? 0 : c - 1, e.shiftKey)
      break
    case 'PageDown':
      void moveCursor(r + page, c, e.shiftKey)
      break
    case 'PageUp':
      void moveCursor(Math.max(0, r - page), c, e.shiftKey)
      break
    case 'Home':
      void moveCursor(mod ? 0 : r, 0, e.shiftKey)
      break
    case 'End':
      void moveCursor(mod ? lastRow : r, lastCol, e.shiftKey)
      break
    case 'Enter':
      if (r < 0) {
        if (props.sortable) emit('sort', colName(c))
      } else if (mod && !isInsert) {
        if (fkOf(c) && !isNull(cellValue(r, c))) emit('fkNavigate', colName(c), cellValue(r, c))
      } else activateCell(r, c)
      break
    case 'F2':
      if (r < 0) return
      activateCell(r, c)
      break
    case ' ':
      if (r < 0) {
        if (props.selectable) emit('toggleSelectAll')
      } else if (isInsert) activateCell(r, c)
      else if (props.selectable && !e.shiftKey) emit('toggleSelect', r)
      else emit('selectRow', r)
      break
    case 'F10': {
      if (!e.shiftKey) return
      const cell = document.getElementById(cellId(r, c))
      if (cell) openContextMenuAt(cell)
      break
    }
    case 'c':
    case 'C':
      if (!mod || cellSel.value || r < 0 || isInsert) return
      cellSel.value = { a: { r, c }, f: { r, c } }
      void copyBlock(e.shiftKey ? 'md' : 'tsv')
      break
    case 'Delete':
    case 'Backspace':
      if (!isInsert) return
      emit('removeInsert', r - totalRows.value)
      cursor.value = { r: Math.max(0, r - 1), c }
      break
    default:
      return
  }
  e.preventDefault()
  e.stopPropagation()
}

// ---- row virtualization (windowing) ----------------------------------------
// Rendering every row of a large result (50K+) builds hundreds of thousands of
// reactive cells synchronously and freezes the app. Instead we render only the
// rows in (and just around) the viewport, with spacer rows reserving the height
// of everything above and below so the scrollbar still spans the full result.
const OVERSCAN = 12
const scrollTop = ref(0)
const viewportH = ref(600)
const rowH = ref(32) // measured from a real row after mount; sensible default

const totalRows = computed(() => props.result?.rows.length ?? 0)
const winStart = computed(() => Math.max(0, Math.floor(scrollTop.value / rowH.value) - OVERSCAN))
const winCount = computed(() => Math.ceil(viewportH.value / rowH.value) + OVERSCAN * 2)
const winEnd = computed(() => Math.min(totalRows.value, winStart.value + winCount.value))
const topPad = computed(() => winStart.value * rowH.value)
const bottomPad = computed(() => Math.max(0, (totalRows.value - winEnd.value) * rowH.value))

// Visible window paired with each row's absolute index in result.rows.
const visibleRows = computed(() => {
  const rows = props.result?.rows ?? []
  const out: { row: unknown[]; r: number }[] = []
  for (let i = winStart.value; i < winEnd.value; i++) out.push({ row: rows[i] as unknown[], r: i })
  return out
})

// The gutter grows with the highest row number so 5-digit rows are never clipped.
const gutterW = computed(() => Math.max(48, String(totalRows.value).length * 8 + 24))

// Columns a full-width spacer row must span (data cols + gutter columns).
const spanCols = computed(() => {
  let n = (props.result?.columns.length ?? 0) + 1 // + row-number column
  if (props.selectable) n++
  if (props.actionLabel) n++
  return n
})

function onScroll(): void {
  if (wrap.value) scrollTop.value = wrap.value.scrollTop
}
function measure(): void {
  const el = wrap.value
  if (!el) return
  viewportH.value = el.clientHeight || 600
  const row = el.querySelector('tbody tr.data-row') as HTMLElement | null
  if (row && row.offsetHeight > 0) rowH.value = row.offsetHeight
}

let resizeObs: ResizeObserver | undefined
onMounted(() => {
  wrap.value?.addEventListener('scroll', onScroll, { passive: true })
  nextTick(measure)
  if (wrap.value && 'ResizeObserver' in window) {
    resizeObs = new ResizeObserver(() => measure())
    resizeObs.observe(wrap.value)
  }
})
onBeforeUnmount(() => {
  wrap.value?.removeEventListener('scroll', onScroll)
  resizeObs?.disconnect()
})

// A new result set resets the scroll position and re-measures the row height.
watch(
  () => props.result,
  () => {
    scrollTop.value = 0
    cursor.value = null
    if (wrap.value) wrap.value.scrollTop = 0
    nextTick(measure)
  }
)
</script>

<template>
  <div ref="wrap" class="grid-wrap">
    <table
      v-if="hasRows"
      ref="table"
      class="grid"
      :class="{ selectable, dragging }"
      :style="{ '--gutter': `${gutterW}px` }"
      role="grid"
      tabindex="0"
      aria-label="Results"
      aria-multiselectable="true"
      :aria-rowcount="lastCursorRow + 2"
      :aria-colcount="result!.columns.length"
      :aria-readonly="!editable"
      :aria-activedescendant="cursor ? cellId(cursor.r, cursor.c) : undefined"
      @focus="onTableFocus"
      @blur="tableFocused = false"
      @keydown="onGridKeydown"
    >
      <thead>
        <tr aria-rowindex="1">
          <th v-if="selectable" class="selcol">
            <input type="checkbox" tabindex="-1" :checked="allSelected" aria-label="Select all rows" title="Select all rows" @change="emit('toggleSelectAll')" />
          </th>
          <th class="rownum">#</th>
          <th v-if="actionLabel" class="actcol"></th>
          <th
            v-for="(col, i) in result!.columns"
            :id="cellId(-1, i)"
            :key="i"
            scope="col"
            role="columnheader"
            :aria-colindex="i + 1"
            :aria-sort="sort?.column === col.name ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined"
            :class="{ sortable, frozen: i === 0 && !actionLabel, cursor: isCursor(-1, i) }"
            @click="sortable && emit('sort', col.name)"
            @contextmenu.prevent="emit('headerContext', col.name, $event)"
          >
            <span>{{ col.name }}</span>
            <Icon v-if="sort?.column === col.name" class="sort-ind" :name="sort.dir === 'asc' ? 'chevronUp' : 'chevronDown'" :size="12" />
          </th>
        </tr>
      </thead>
      <tbody>
        <!-- spacer reserving the height of the rows scrolled off the top -->
        <tr v-if="topPad > 0" class="spacer" aria-hidden="true">
          <td :colspan="spanCols" :style="{ height: topPad + 'px', padding: 0, border: 0 }"></td>
        </tr>

        <!-- existing rows (only the visible window is rendered) -->
        <tr
          v-for="{ row, r } in visibleRows"
          :key="r"
          class="data-row"
          :aria-rowindex="r + 2"
          :aria-selected="isSelected(r) || selectedRow === r"
          :class="{ zebra: r % 2 === 1, selected: selectedRow === r, 'multi-selected': isSelected(r), deleted: isDeleted(r) }"
          @click="onRowClick(r)"
          @contextmenu.prevent="emit('rowContext', r, $event)"
        >
          <td v-if="selectable" class="selcol" @click.stop>
            <input type="checkbox" tabindex="-1" :checked="isSelected(r)" :aria-label="`Select row ${r + 1}`" @change="emit('toggleSelect', r)" />
          </td>
          <td class="rownum">{{ r + 1 }}</td>
          <td v-if="actionLabel" class="actcol">
            <button class="row-act" @click.stop="emit('action', row as unknown[])">{{ actionLabel }}</button>
          </td>
          <td
            v-for="(_, c) in row"
            :id="cellId(r, c)"
            :key="c"
            role="gridcell"
            :aria-colindex="c + 1"
            :aria-description="isDirty(r, c) ? 'Edited, not saved' : undefined"
            :class="{ cursor: isCursor(r, c), null: isNull(cellValue(r, c)), dirty: isDirty(r, c), editing: isEditing('data', r, c), fk: !!fkOf(c), 'cell-sel': inCellSel(r, c), frozen: c === 0 && !actionLabel }"
            :title="fkOf(c) && !isNull(cellValue(r, c)) ? `Go to ${fkOf(c)!.toTable} where ${fkOf(c)!.toColumn} = ${display(cellValue(r, c))}` : display(cellValue(r, c))"
            @mousedown="onCellMouseDown(r, c, $event)"
            @mouseenter="onCellMouseEnter(r, c)"
            @dblclick="onCellDblClick(r, c)"
            @contextmenu.prevent.stop="emit('rowContext', r, $event, c)"
          >
            <input
              v-if="isEditing('data', r, c)"
              v-autofocus
              class="cell-input"
              v-model="editValue"
              :aria-label="colName(c)"
              @keydown.enter.prevent.stop="commitFromKeyboard"
              @keydown.esc.prevent.stop="cancelEdit"
              @blur="commitEdit"
              @click.stop
            />
            <template v-else>
              <span class="cell-text">{{ display(cellValue(r, c)) }}</span>
              <button
                v-if="fkOf(c) && !isNull(cellValue(r, c))"
                class="fk-jump"
                tabindex="-1"
                title="Go to related row (⌘↵)"
                @click.stop="emit('fkNavigate', colName(c), cellValue(r, c))"
              ><Icon name="arrowRight" :size="12" /></button>
            </template>
          </td>
        </tr>

        <!-- spacer reserving the height of the rows scrolled off the bottom -->
        <tr v-if="bottomPad > 0" class="spacer" aria-hidden="true">
          <td :colspan="spanCols" :style="{ height: bottomPad + 'px', padding: 0, border: 0 }"></td>
        </tr>

        <!-- pending new rows -->
        <tr v-for="(ins, i) in inserts" :key="'ins-' + i" class="insert-row" :aria-rowindex="totalRows + i + 2" aria-description="New row, not saved">
          <td v-if="selectable" class="selcol"></td>
          <td class="rownum">
            <button class="remove-insert" title="Remove" @click.stop="emit('removeInsert', i)"><Icon name="x" :size="11" /></button>
          </td>
          <td v-if="actionLabel" class="actcol"></td>
          <td
            v-for="(col, c) in result!.columns"
            :id="cellId(totalRows + i, c)"
            :key="c"
            role="gridcell"
            :aria-colindex="c + 1"
            :class="{ cursor: isCursor(totalRows + i, c), null: isNull(insertValue(i, c)), editing: isEditing('insert', i, c), frozen: c === 0 && !actionLabel }"
            @dblclick="startEdit('insert', i, c)"
          >
            <input
              v-if="isEditing('insert', i, c)"
              v-autofocus
              class="cell-input"
              v-model="editValue"
              :aria-label="colName(c)"
              @keydown.enter.prevent.stop="commitFromKeyboard"
              @keydown.esc.prevent.stop="cancelEdit"
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
  font-size: var(--fs-sm);
}
thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-elevated);
  text-align: left;
  font-weight: 600;
  font-size: var(--fs-sm);
  color: var(--text-dim);
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
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
  color: var(--accent-text);
}
.grid:focus-visible {
  outline: none;
}
.grid .cursor {
  outline: 2px solid var(--accent-text);
  outline-offset: -2px;
}
tbody td {
  padding: 7px 14px;
  border-bottom: 1px solid var(--border-soft);
  white-space: nowrap;
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--mono);
  font-size: var(--fs-base);
  color: var(--text);
}
/* Faint zebra striping — lets the eye track across wide rows without hard lines.
   Keyed off the absolute row index (not :nth-child) so the stripes stay stable
   as virtualized spacer rows shift DOM-position parity during scrolling. */
/* Row and cell states set --tint; the cell paints it over --base. Frozen cells have
   an opaque base, so a tint can never let scrolled cells show through them. */
tbody td {
  --base: transparent;
  --tint: transparent;
  background: linear-gradient(var(--tint), var(--tint)), var(--base);
}
tbody tr.zebra td {
  --tint: var(--bg-zebra);
}
/* Spacer rows just reserve scroll height — never paint or react to hover. */
tbody tr.spacer td,
tbody tr.spacer:hover td {
  --tint: transparent;
}
tbody tr:hover td {
  --tint: var(--bg-hover);
}
tbody tr.selected td,
tbody tr.multi-selected td {
  --tint: var(--accent-soft);
}
/* Rectangular cell-block selection (drag + ⌘C). Wins over row backgrounds. */
.grid.dragging {
  user-select: none;
}
tbody td.cell-sel {
  --tint: var(--accent-selection) !important;
  box-shadow: inset 0 0 0 1px var(--accent-ring);
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
  --base: var(--bg-elevated);
  --tint: transparent;
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
  --tint: var(--danger-soft) !important;
  color: var(--danger-text);
  text-decoration: line-through;
}
tbody tr.insert-row td {
  --tint: var(--ok-soft);
}
td.dirty {
  --tint: var(--warn-soft) !important;
  color: var(--warn-text);
}
/* Corner mark: edited cells must not be told apart by colour alone. */
tbody td.dirty:not(.frozen) {
  position: relative;
}
td.dirty::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  border: 5px solid;
  border-color: var(--warn-text) var(--warn-text) transparent transparent;
}
/* Foreign-key cells: value reads as a link, arrow jumps to the related row. */
td.fk {
  position: relative;
}
td.fk:not(.null) .cell-text {
  color: var(--accent-text);
}
.fk-jump {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  opacity: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--accent-text);
  border-radius: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
}
td.fk:hover .fk-jump,
td.fk.cursor .fk-jump {
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
  font-size: var(--fs-sm);
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
  width: var(--gutter);
  min-width: var(--gutter);
  max-width: var(--gutter);
  font-variant-numeric: tabular-nums;
  border-right: 1px solid var(--border);
}
/* Freeze the first data column so the key/id stays visible while scrolling a
   wide table sideways — it extends the sticky left gutter. (Skipped when an
   action column is present, so the offset stays exact.) */
thead th.frozen,
tbody td.frozen {
  position: sticky;
  z-index: 1;
  left: var(--gutter);
}
.grid.selectable thead th.frozen,
.grid.selectable tbody td.frozen {
  left: calc(var(--gutter) + 36px);
}
.grid tbody td.frozen {
  --base: var(--bg-panel);
  box-shadow: inset -1px 0 0 var(--border-soft);
}
.grid thead th.frozen {
  background: var(--bg-elevated);
  box-shadow: inset -1px 0 0 var(--border-soft);
}
thead th.frozen {
  z-index: 3;
}
.grid .rownum {
  padding-inline: 6px;
  text-overflow: clip;
}
thead .rownum {
  z-index: 3;
}
.remove-insert {
  color: var(--danger-text);
  font-size: var(--fs-xs);
  width: 24px;
  height: 24px;
  border-radius: 3px;
}
.remove-insert:hover {
  background: var(--danger-soft);
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
  color: var(--danger-text);
  font-size: var(--fs-xs);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid transparent;
}
.row-act:hover {
  background: var(--danger-soft);
  border-color: var(--danger);
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
