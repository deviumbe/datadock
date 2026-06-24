<script setup lang="ts">
import { ref, watch } from 'vue'
import type { AnalyticsDataset, AnalyticsMetric } from '@shared/types'
import { buildChartSql } from '../lib/analyticsSql'
import { kpiValue, formatMetric } from '../lib/chartOption'

const props = defineProps<{
  metric: AnalyticsMetric
  dataset: AnalyticsDataset | undefined
  connectionId: string
  driver: string
}>()
const emit = defineEmits<{ edit: [metric: AnalyticsMetric]; remove: [metric: AnalyticsMetric] }>()

const text = ref('…')
const error = ref('')

async function load(): Promise<void> {
  if (!props.dataset) {
    error.value = 'Dataset missing.'
    return
  }
  error.value = ''
  try {
    const sql = buildChartSql(props.driver, props.dataset.source, {
      yAgg: props.metric.agg,
      yColumn: props.metric.column,
      filters: props.metric.filters
    })
    const res = await window.api.db.query(props.connectionId, sql)
    text.value = formatMetric(kpiValue(res), props.metric.format)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    text.value = '—'
  }
}
watch(() => [props.metric.updatedAt, props.dataset?.id], load, { immediate: true })
</script>

<template>
  <div class="mcard">
    <span v-if="metric.icon" class="m-icon">{{ metric.icon }}</span>
    <div class="m-body">
      <span class="m-label">{{ metric.name }}</span>
      <span class="m-value" :class="{ err: !!error }" :title="error || ''">{{ error ? 'Error' : text }}</span>
    </div>
    <div class="m-actions">
      <button class="ic" title="Edit" @click="emit('edit', metric)">✎</button>
      <button class="ic" title="Delete" @click="emit('remove', metric)">🗑</button>
    </div>
  </div>
</template>

<style scoped>
.mcard {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
}
.m-icon {
  font-size: 28px;
  line-height: 1;
}
.m-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.m-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.05;
}
.m-value.err {
  font-size: 14px;
  color: var(--danger);
}
.m-actions {
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
</style>
