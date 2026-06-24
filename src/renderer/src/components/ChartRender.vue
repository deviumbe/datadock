<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ChartType, MetricFormat, QueryResult } from '@shared/types'
import { optionForChart, optionForResult, kpiValue, formatMetric, pivotModel } from '../lib/chartOption'
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
  /** Display formatting for the KPI value. */
  format?: MetricFormat
}>()
const emit = defineEmits<{ drill: [{ name: string; seriesName?: string }] }>()

const option = computed(() => {
  if (!props.result) return null
  return props.instant
    ? optionForResult(props.result, props.type)
    : optionForChart(props.type, props.result)
})

const kpi = computed(() => (props.result ? kpiValue(props.result) : null))
const kpiText = computed(() => formatMetric(kpi.value, props.format))

const pivot = computed(() => (props.result ? pivotModel(props.result) : null))
const fmtCell = (v: number): string => v.toLocaleString(undefined, { maximumFractionDigits: 2 })

const chartRef = ref<InstanceType<typeof EChart> | null>(null)
/** PNG snapshot (charts only) for PDF/report export. */
function image(): string | null {
  return chartRef.value?.image() ?? null
}
defineExpose({ image })
</script>

<template>
  <div class="chart-render">
    <div v-if="!result || !result.rows.length" class="cr-empty">No data.</div>

    <!-- KPI card -->
    <div v-else-if="type === 'kpi'" class="kpi">
      <div class="kpi-top">
        <span v-if="icon" class="kpi-chip">{{ icon }}</span>
        <span class="kpi-label">{{ label ?? 'Value' }}</span>
      </div>
      <div class="kpi-value">{{ kpiText }}</div>
    </div>

    <!-- Pivot table (rows × columns matrix with totals) -->
    <div v-else-if="type === 'pivot'" class="cr-table">
      <div v-if="!pivot" class="cr-empty">Pick a Rows and Columns dimension to pivot.</div>
      <table v-else class="pivot">
        <thead>
          <tr>
            <th class="corner"></th>
            <th v-for="c in pivot.colKeys" :key="c">{{ pivot.singleCol ? (label ?? 'Total') : c }}</th>
            <th class="tot">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in pivot.rowKeys" :key="r">
            <th class="rowhead">{{ r }}</th>
            <td
              v-for="c in pivot.colKeys"
              :key="c"
              class="num clickable"
              @click="emit('drill', { name: r, seriesName: pivot!.singleCol ? undefined : c })"
            >{{ fmtCell(pivot.value(r, c)) }}</td>
            <td class="num tot">{{ fmtCell(pivot.rowTotal(r)) }}</td>
          </tr>
          <tr class="totrow">
            <th class="rowhead">Total</th>
            <td v-for="c in pivot.colKeys" :key="c" class="num">{{ fmtCell(pivot.colTotal(c)) }}</td>
            <td class="num tot">{{ fmtCell(pivot.grand) }}</td>
          </tr>
        </tbody>
      </table>
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
    <EChart v-else-if="option" ref="chartRef" :option="option" @point-click="emit('drill', $event)" />
    <div v-else class="cr-empty">This data can't be charted as a {{ type }}.</div>
  </div>
</template>

<style scoped>
.chart-render {
  width: 100%;
  height: 100%;
  min-height: 0;
  container-type: inline-size;
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
  flex-direction: column;
  justify-content: center;
  height: 100%;
  padding: 18px 20px;
  gap: 14px;
}
.kpi-top {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.kpi-chip {
  width: 32px;
  height: 32px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  line-height: 1;
  border-radius: 9px;
  background: var(--accent-soft);
}
.kpi-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kpi-value {
  font-family: var(--font-display);
  font-size: clamp(26px, 6cqw, 40px);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
  line-height: 1.05;
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
.pivot .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pivot .rowhead {
  position: sticky;
  left: 0;
  background: var(--bg-panel);
  color: var(--text);
  font-weight: 600;
  text-align: left;
}
.pivot .corner {
  left: 0;
  z-index: 1;
}
.pivot .tot {
  font-weight: 700;
  color: var(--text);
  background: var(--bg-elevated);
}
.pivot .totrow td,
.pivot .totrow th {
  border-top: 2px solid var(--border-strong);
  font-weight: 700;
  color: var(--text);
}
.pivot .clickable {
  cursor: pointer;
}
.pivot .clickable:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
</style>
