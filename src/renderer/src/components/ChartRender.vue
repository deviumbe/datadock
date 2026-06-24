<script setup lang="ts">
import { computed } from 'vue'
import type { ChartType, QueryResult } from '@shared/types'
import { optionForChart, optionForResult, kpiValue } from '../lib/chartOption'
import EChart from './EChart.vue'

const props = defineProps<{
  type: ChartType
  result: QueryResult | null
  /** Instant mode renders an arbitrary result (auto-detected) instead of x/series/y. */
  instant?: boolean
  /** Optional label shown above a KPI value. */
  label?: string
  /** Optional emoji shown on a KPI card. */
  icon?: string
}>()

const option = computed(() => {
  if (!props.result) return null
  return props.instant
    ? optionForResult(props.result, props.type)
    : optionForChart(props.type, props.result)
})

const kpi = computed(() => (props.result ? kpiValue(props.result) : null))
const kpiText = computed(() =>
  kpi.value === null ? '—' : kpi.value.toLocaleString(undefined, { maximumFractionDigits: 2 })
)
</script>

<template>
  <div class="chart-render">
    <div v-if="!result || !result.rows.length" class="cr-empty">No data.</div>

    <!-- KPI card -->
    <div v-else-if="type === 'kpi'" class="kpi">
      <span v-if="icon" class="kpi-icon">{{ icon }}</span>
      <div class="kpi-text">
        <span class="kpi-label">{{ label ?? 'Value' }}</span>
        <span class="kpi-value">{{ kpiText }}</span>
      </div>
    </div>

    <!-- Raw table -->
    <div v-else-if="type === 'table'" class="cr-table">
      <table>
        <thead>
          <tr>
            <th v-for="c in result.columns" :key="c.name">{{ c.name }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, ri) in result.rows.slice(0, 200)" :key="ri">
            <td v-for="(cell, ci) in r" :key="ci">{{ cell === null ? 'NULL' : String(cell) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Graphical chart -->
    <EChart v-else-if="option" :option="option" />
    <div v-else class="cr-empty">This data can't be charted as a {{ type }}.</div>
  </div>
</template>

<style scoped>
.chart-render {
  width: 100%;
  height: 100%;
  min-height: 0;
}
.cr-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-faint);
  font-size: 13px;
}
.kpi {
  display: flex;
  flex-direction: row;
  align-items: center;
  height: 100%;
  padding: 16px 20px;
  gap: 16px;
}
.kpi-icon {
  font-size: 38px;
  line-height: 1;
  flex: none;
}
.kpi-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.kpi-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-faint);
  font-weight: 600;
}
.kpi-value {
  font-size: 42px;
  font-weight: 700;
  color: var(--text);
  line-height: 1;
}
.cr-table {
  height: 100%;
  overflow: auto;
}
.cr-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.cr-table th,
.cr-table td {
  text-align: left;
  padding: 5px 9px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  color: var(--text);
}
.cr-table th {
  position: sticky;
  top: 0;
  background: var(--bg-panel);
  color: var(--text-dim);
  font-weight: 600;
}
</style>
