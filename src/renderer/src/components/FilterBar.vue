<script setup lang="ts">
import { ref, watch } from 'vue'
import Icon from './Icon.vue'
import type { ColumnMeta, FilterOp, FilterSpec } from '@shared/types'

const props = defineProps<{ columns: ColumnMeta[]; filters: FilterSpec[] }>()
const emit = defineEmits<{ apply: [filters: FilterSpec[]] }>()

// Grouped for the dropdown: comparison, text matching, sets/ranges, null checks.
const OP_GROUPS: { label: string; ops: FilterOp[] }[] = [
  { label: 'Compare', ops: ['=', '!=', '<', '<=', '>', '>='] },
  { label: 'Text', ops: ['contains', 'not contains', 'starts', 'ends', 'like', 'not like'] },
  { label: 'Set / range', ops: ['in', 'not in', 'between'] },
  { label: 'Null', ops: ['is null', 'not null'] }
]
const OP_LABELS: Record<FilterOp, string> = {
  '=': '=',
  '!=': '≠',
  '<': '<',
  '<=': '≤',
  '>': '>',
  '>=': '≥',
  contains: 'contains',
  'not contains': 'not contains',
  starts: 'starts with',
  ends: 'ends with',
  like: 'LIKE',
  'not like': 'NOT LIKE',
  in: 'IN',
  'not in': 'NOT IN',
  between: 'between',
  'is null': 'is null',
  'not null': 'not null'
}
const noValue = (op: FilterOp): boolean => op === 'is null' || op === 'not null'
const isRange = (op: FilterOp): boolean => op === 'between'
const isList = (op: FilterOp): boolean => op === 'in' || op === 'not in'
function placeholderFor(op: FilterOp): string {
  if (isList(op)) return 'a, b, c'
  if (op === 'like' || op === 'not like') return '%pattern%'
  return 'value'
}

const local = ref<FilterSpec[]>(props.filters.map((f) => ({ ...f })))

watch(
  () => props.filters,
  (f) => {
    local.value = f.map((x) => ({ ...x }))
  }
)

function add(): void {
  local.value.push({ column: props.columns[0]?.name ?? '', op: '=', value: '' })
}
function remove(i: number): void {
  local.value.splice(i, 1)
  apply()
}
function apply(): void {
  emit('apply', local.value.filter((f) => f.column).map((f) => ({ ...f })))
}
</script>

<template>
  <div class="filter-bar">
    <button class="btn btn-ghost add" :disabled="!columns.length" @click="add"><Icon name="filter" :size="13" /> Filter</button>
    <div v-for="(f, i) in local" :key="i" class="filter">
      <select class="select sm" v-model="f.column" @change="apply">
        <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
      </select>
      <select class="select sm op" v-model="f.op" @change="apply">
        <optgroup v-for="g in OP_GROUPS" :key="g.label" :label="g.label">
          <option v-for="op in g.ops" :key="op" :value="op">{{ OP_LABELS[op] }}</option>
        </optgroup>
      </select>
      <template v-if="!noValue(f.op)">
        <input
          class="input sm"
          v-model="f.value"
          :placeholder="placeholderFor(f.op)"
          @keydown.enter="apply"
          @blur="apply"
        />
        <template v-if="isRange(f.op)">
          <span class="and">and</span>
          <input
            class="input sm"
            v-model="f.value2"
            placeholder="value"
            @keydown.enter="apply"
            @blur="apply"
          />
        </template>
      </template>
      <button class="btn-ghost rm" @click="remove(i)"><Icon name="x" :size="13" /></button>
    </div>
    <span v-if="local.length === 0" class="hint">No filters</span>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-soft);
  /* Single row that scrolls horizontally — adding filters never changes the
     bar's height, so the grid below never jumps. */
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  min-height: 45px;
  background: var(--bg-app);
}
.filter-bar::-webkit-scrollbar {
  height: 0;
}
.add {
  padding: 4px 9px;
  font-size: 12px;
  flex-shrink: 0;
}
.filter {
  display: flex;
  align-items: center;
  gap: 3px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 3px;
  flex-shrink: 0;
}
.sm {
  padding: 3px 6px;
  font-size: 12px;
}
.select.sm {
  max-width: 130px;
}
.op {
  min-width: 88px;
}
.input.sm {
  width: 110px;
}
.and {
  color: var(--text-faint);
  font-size: 11px;
  padding: 0 1px;
}
.rm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  width: 20px;
  height: 20px;
  border-radius: 4px;
}
.rm:hover {
  color: var(--danger);
  background: var(--bg-hover);
}
.hint {
  color: var(--text-faint);
  font-size: 12px;
}
</style>
