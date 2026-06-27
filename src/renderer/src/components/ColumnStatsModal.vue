<script setup lang="ts">
// Quick column profile: total / distinct / null counts and min / max, fetched
// with a single aggregate query against the table.
import { ref, onMounted, computed } from 'vue'
import Modal from './Modal.vue'
import type { TableInfo } from '@shared/types'
import { buildStatsSql } from '../lib/columnStats'

const props = defineProps<{ connId: string; driver: string; table: TableInfo; column: string }>()
const emit = defineEmits<{ close: [] }>()

const loading = ref(true)
const error = ref('')
const stats = ref<{
  total: number
  nonNull: number
  distinct: number
  min: unknown
  max: unknown
} | null>(null)

const nullCount = computed(() => (stats.value ? stats.value.total - stats.value.nonNull : 0))
const nullPct = computed(() =>
  stats.value && stats.value.total > 0
    ? `${((nullCount.value / stats.value.total) * 100).toFixed(1)}%`
    : '—'
)
function show(v: unknown): string {
  return v === null || v === undefined ? 'NULL' : String(v)
}

onMounted(async () => {
  try {
    const sql = buildStatsSql(props.driver, props.table, props.column)
    const res = await window.api.db.query(props.connId, sql)
    const row = res.rows[0] ?? []
    const idx = (name: string): number => res.columns.findIndex((c) => c.name === name)
    stats.value = {
      total: Number(row[idx('total')] ?? 0),
      nonNull: Number(row[idx('non_null')] ?? 0),
      distinct: Number(row[idx('distinct_count')] ?? 0),
      min: row[idx('min_val')],
      max: row[idx('max_val')]
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <Modal :title="`Column stats · ${column}`" @close="emit('close')">
    <p v-if="loading" class="state">Profiling…</p>
    <p v-else-if="error" class="state err">{{ error }}</p>
    <div v-else-if="stats" class="grid">
      <div class="stat"><span class="k">Rows</span><span class="v">{{ stats.total.toLocaleString() }}</span></div>
      <div class="stat"><span class="k">Distinct</span><span class="v">{{ stats.distinct.toLocaleString() }}</span></div>
      <div class="stat"><span class="k">Nulls</span><span class="v">{{ nullCount.toLocaleString() }} · {{ nullPct }}</span></div>
      <div class="stat"><span class="k">Non-null</span><span class="v">{{ stats.nonNull.toLocaleString() }}</span></div>
      <div class="stat wide"><span class="k">Min</span><span class="v mono">{{ show(stats.min) }}</span></div>
      <div class="stat wide"><span class="k">Max</span><span class="v mono">{{ show(stats.max) }}</span></div>
    </div>
  </Modal>
</template>

<style scoped>
.state {
  font-size: 13px;
  color: var(--text-dim);
  padding: 6px 0;
}
.state.err {
  color: var(--danger);
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.stat.wide {
  grid-column: 1 / -1;
}
.k {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}
.v {
  font-size: 15px;
  font-weight: 600;
}
.v.mono {
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 500;
  word-break: break-word;
}
</style>
