<script setup lang="ts">
import Icon from './Icon.vue'
import type { ColumnMeta } from '@shared/types'

const props = defineProps<{
  columns: ColumnMeta[]
  row: unknown[]
  rowIndex: number
  edits?: Record<string, unknown>
  primaryKeys: string[]
  editable: boolean
  dirtyCount: number
  /** Column name -> whether it accepts NULL (from the table structure). */
  nullable?: Record<string, boolean>
}>()

const emit = defineEmits<{
  editCell: [rowIndex: number, column: string, value: unknown]
  setNull: [rowIndex: number, column: string]
  commit: []
  discard: []
  close: []
}>()

function value(col: ColumnMeta, i: number): string {
  const e = props.edits
  const v = e && col.name in e ? e[col.name] : props.row[i]
  return v === null || v === undefined ? '' : String(v)
}
function isNull(col: ColumnMeta, i: number): boolean {
  const e = props.edits
  const v = e && col.name in e ? e[col.name] : props.row[i]
  return v === null || v === undefined
}
function dirty(col: ColumnMeta): boolean {
  return !!props.edits && col.name in props.edits
}
function onInput(col: ColumnMeta, ev: Event): void {
  emit('editCell', props.rowIndex, col.name, (ev.target as HTMLInputElement).value)
}
function isPk(name: string): boolean {
  return props.primaryKeys.includes(name)
}
/** Show a NULL toggle only for editable, nullable, non-PK columns. */
function canNull(col: ColumnMeta): boolean {
  return props.editable && !isPk(col.name) && props.nullable?.[col.name] === true
}
function toggleNull(col: ColumnMeta, i: number): void {
  // Null → restore the original value; otherwise set an explicit NULL.
  if (isNull(col, i)) emit('editCell', props.rowIndex, col.name, props.row[i])
  else emit('setNull', props.rowIndex, col.name)
}
</script>

<template>
  <aside class="detail">
    <header class="detail-head">
      <span class="title">Row {{ rowIndex + 1 }}</span>
      <div class="spacer" />
      <button class="btn-ghost close" @click="emit('close')"><Icon name="x" :size="14" /></button>
    </header>

    <div class="fields">
      <div v-for="(col, i) in columns" :key="col.name" class="field-row" :class="{ dirty: dirty(col) }">
        <label>
          {{ col.name }}
          <span v-if="isPk(col.name)" class="pk" title="Primary key">PK</span>
          <span v-if="col.type" class="type">{{ col.type }}</span>
        </label>
        <input
          class="input"
          :class="{ 'is-null': isNull(col, i) }"
          :value="value(col, i)"
          :placeholder="isNull(col, i) ? 'NULL' : ''"
          :readonly="!editable"
          @input="onInput(col, $event)"
        />
        <button
          v-if="canNull(col)"
          type="button"
          class="null-toggle"
          :class="{ on: isNull(col, i) }"
          :title="isNull(col, i) ? 'Restore the original value' : 'Set this field to NULL'"
          @click="toggleNull(col, i)"
        >
          {{ isNull(col, i) ? '✓ NULL' : 'Set NULL' }}
        </button>
      </div>
    </div>

    <footer v-if="editable" class="detail-foot">
      <span class="dirty-info" v-if="dirtyCount">{{ dirtyCount }} unsaved</span>
      <div class="spacer" />
      <button class="btn btn-ghost" :disabled="!dirtyCount" @click="emit('discard')">Discard</button>
      <button class="btn btn-primary" :disabled="!dirtyCount" @click="emit('commit')">Save ⌘S</button>
    </footer>
    <footer v-else class="detail-foot readonly">No primary key — read-only</footer>
  </aside>
</template>

<style scoped>
.detail {
  width: 320px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.detail-head {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-soft);
}
.title {
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  color: var(--text-dim);
}
.close:hover {
  background: var(--bg-hover);
}
.fields {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.field-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-left: 8px;
  border-left: 2px solid transparent;
}
.field-row.dirty {
  border-left-color: var(--warn);
}
.field-row label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 6px;
}
.pk {
  font-size: 9px;
  font-weight: 700;
  background: var(--accent-soft);
  color: var(--accent);
  padding: 1px 4px;
  border-radius: 3px;
}
.type {
  font-weight: 400;
  color: var(--text-faint);
  text-transform: none;
}
.input {
  font-family: var(--mono);
}
.input.is-null {
  color: var(--text-faint);
  font-style: italic;
}
.null-toggle {
  align-self: flex-start;
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-faint);
}
.null-toggle:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.null-toggle.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.detail-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border-soft);
}
.detail-foot.readonly {
  color: var(--text-faint);
  font-size: 12px;
  justify-content: center;
}
.dirty-info {
  font-size: 11px;
  color: var(--warn);
}
</style>
