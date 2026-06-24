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
    <div class="m-top">
      <span v-if="metric.icon" class="m-chip">{{ metric.icon }}</span>
      <span class="m-label">{{ metric.name }}</span>
      <div class="m-actions">
        <button class="ic" title="Edit" @click="emit('edit', metric)">✎</button>
        <button class="ic" title="Delete" @click="emit('remove', metric)">🗑</button>
      </div>
    </div>
    <span class="m-value" :class="{ err: !!error }" :title="error || ''">{{ error ? 'Error' : text }}</span>
  </div>
</template>

<style scoped>
.mcard {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 15px 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-input);
  transition: border-color 0.15s;
}
.mcard:hover {
  border-color: var(--border-strong);
}
.mcard:hover .m-actions {
  opacity: 1;
}
.m-top {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.m-chip {
  width: 30px;
  height: 30px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  line-height: 1;
  border-radius: 9px;
  background: var(--accent-soft);
}
.m-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-value {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
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
  opacity: 0;
  transition: opacity 0.15s;
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
