<script setup lang="ts">
import { ref, watch } from 'vue'
import type { ColumnMeta, FilterOp, FilterSpec } from '@shared/types'

const props = defineProps<{ columns: ColumnMeta[]; filters: FilterSpec[] }>()
const emit = defineEmits<{ apply: [filters: FilterSpec[]] }>()

const OPS: FilterOp[] = ['=', '!=', '<', '<=', '>', '>=', 'contains', 'starts', 'is null', 'not null']
const noValue = (op: FilterOp): boolean => op === 'is null' || op === 'not null'

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
    <button class="btn btn-ghost add" @click="add">＋ Filter</button>
    <div v-for="(f, i) in local" :key="i" class="filter">
      <select class="select sm" v-model="f.column" @change="apply">
        <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
      </select>
      <select class="select sm op" v-model="f.op" @change="apply">
        <option v-for="op in OPS" :key="op" :value="op">{{ op }}</option>
      </select>
      <input
        v-if="!noValue(f.op)"
        class="input sm"
        v-model="f.value"
        placeholder="value"
        @keydown.enter="apply"
        @blur="apply"
      />
      <button class="btn-ghost rm" @click="remove(i)">✕</button>
    </div>
    <span v-if="local.length === 0" class="hint">No filters</span>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  background: var(--bg-app);
}
.add {
  padding: 4px 9px;
  font-size: 12px;
}
.filter {
  display: flex;
  align-items: center;
  gap: 3px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  padding: 3px;
}
.sm {
  padding: 3px 6px;
  font-size: 12px;
}
.select.sm {
  max-width: 130px;
}
.op {
  min-width: 64px;
}
.input.sm {
  width: 110px;
}
.rm {
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
