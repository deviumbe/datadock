<script setup lang="ts">
import { ref, watch } from 'vue'
import type { AnalyticsChart, AnalyticsDataset, QueryResult } from '@shared/types'
import { buildChartSql, datasetRowsSql } from '../lib/analyticsSql'
import ChartRender from './ChartRender.vue'

const props = defineProps<{
  chart: AnalyticsChart
  dataset: AnalyticsDataset | undefined
  connectionId: string
  driver: string
  /** On a dashboard: show a "remove from dashboard" action instead of delete. */
  removable?: boolean
}>()
const emit = defineEmits<{
  edit: [chart: AnalyticsChart]
  remove: [chart: AnalyticsChart]
  removeFromDashboard: [chart: AnalyticsChart]
}>()

const result = ref<QueryResult | null>(null)
const error = ref('')
const loading = ref(false)

async function load(): Promise<void> {
  if (!props.dataset) {
    error.value = 'Dataset missing.'
    return
  }
  loading.value = true
  error.value = ''
  try {
    // The "table" type shows raw dataset rows; everything else is an aggregate.
    const sql =
      props.chart.type === 'table'
        ? datasetRowsSql(props.driver, props.dataset.source)
        : buildChartSql(props.driver, props.dataset.source, props.chart.encoding)
    result.value = await window.api.db.query(props.connectionId, sql)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    result.value = null
  } finally {
    loading.value = false
  }
}
watch(() => [props.chart.updatedAt, props.dataset?.id], load, { immediate: true })
</script>

<template>
  <div class="card">
    <div class="card-head">
      <span class="card-title" :title="chart.name">{{ chart.name }}</span>
      <div class="card-actions">
        <button class="ic" title="Refresh" @click="load">⟳</button>
        <button class="ic" title="Edit" @click="emit('edit', chart)">✎</button>
        <button
          v-if="removable"
          class="ic"
          title="Remove from dashboard"
          @click="emit('removeFromDashboard', chart)"
        >✕</button>
        <button v-else class="ic" title="Delete" @click="emit('remove', chart)">🗑</button>
      </div>
    </div>
    <div class="card-body">
      <div v-if="loading" class="cstate">Loading…</div>
      <div v-else-if="error" class="cstate err">{{ error }}</div>
      <ChartRender v-else :type="chart.type" :result="result" :label="chart.name" :icon="chart.icon" />
    </div>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
  overflow: hidden;
  min-height: 260px;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.ic {
  font-size: 12px;
  color: var(--text-faint);
  padding: 3px 6px;
  border-radius: var(--radius-sm);
}
.ic:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.card-body {
  flex: 1;
  min-height: 220px;
  position: relative;
}
.cstate {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-dim);
  font-size: 12.5px;
}
.cstate.err {
  color: var(--danger);
  padding: 12px;
  text-align: center;
}
</style>
