<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { AnalyticsChart, AnalyticsDataset, FilterSpec, QueryResult } from '@shared/types'
import { buildChartSql, datasetRowsSql, drillRowsSql } from '../lib/analyticsSql'
import { kpiValue, formatMetric, pivotModel, pivotToTable } from '../lib/chartOption'
import type { CardSnapshot } from '../lib/reportHtml'
import { useAnalytics } from '../stores/analytics'
import ChartRender from './ChartRender.vue'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const props = defineProps<{
  chart: AnalyticsChart
  dataset: AnalyticsDataset | undefined
  connectionId: string
  driver: string
  /** On a dashboard: show a "remove from dashboard" action instead of delete. */
  removable?: boolean
  /** Dashboard filters that apply to this widget (already column-matched). */
  extraFilters?: FilterSpec[]
  /** Bump to force a reload (realtime auto-refresh). */
  refreshKey?: number
}>()
const emit = defineEmits<{
  edit: [chart: AnalyticsChart]
  remove: [chart: AnalyticsChart]
  removeFromDashboard: [chart: AnalyticsChart]
}>()

const analytics = useAnalytics()
const result = ref<QueryResult | null>(null)
const error = ref('')
const loading = ref(false)

/** The chart's encoding resolved through its saved metric (if bound) + filters. */
const encoding = computed(() => {
  const base = analytics.effectiveEncoding(props.chart.encoding)
  if (props.extraFilters?.length) {
    return { ...base, filters: [...(base.filters ?? []), ...props.extraFilters] }
  }
  return base
})
const metricFormat = computed(() => {
  const id = props.chart.encoding.metricId
  return id ? analytics.getMetric(id)?.format : undefined
})
const canDrill = computed(
  () => props.chart.type !== 'kpi' && props.chart.type !== 'table' && !!encoding.value.x
)

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
        : buildChartSql(props.driver, props.dataset.source, encoding.value)
    result.value = await window.api.db.query(props.connectionId, sql)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    result.value = null
  } finally {
    loading.value = false
  }
}
watch(
  () => [props.chart.updatedAt, props.dataset?.id, props.extraFilters, props.refreshKey],
  load,
  { immediate: true, deep: true }
)

// ---- drill-through ---------------------------------------------------------
const drillOpen = ref(false)
const drillTitle = ref('')
const drillRows = ref<QueryResult | null>(null)
const drillError = ref('')
const drillLoading = ref(false)

async function onDrill(p: { name: string; seriesName?: string }): Promise<void> {
  if (!props.dataset || !canDrill.value) return
  drillOpen.value = true
  drillLoading.value = true
  drillError.value = ''
  drillRows.value = null
  drillTitle.value = p.seriesName ? `${p.name} · ${p.seriesName}` : p.name
  try {
    const sql = drillRowsSql(
      props.driver,
      props.dataset.source,
      encoding.value,
      p.name,
      p.seriesName
    )
    drillRows.value = await window.api.db.query(props.connectionId, sql)
  } catch (e) {
    drillError.value = e instanceof Error ? e.message : String(e)
  } finally {
    drillLoading.value = false
  }
}

// ---- export ----------------------------------------------------------------
const exportOpen = ref(false)
async function exportData(format: 'csv' | 'xlsx' | 'json'): Promise<void> {
  exportOpen.value = false
  if (!result.value) return
  await window.api.io.exportData(props.connectionId, format, {
    columns: result.value.columns,
    rows: result.value.rows,
    tableName: props.chart.name.replace(/[^\w.-]+/g, '_') || 'chart'
  })
}

// ---- snapshot for PDF/report export ----------------------------------------
const renderRef = ref<InstanceType<typeof ChartRender> | null>(null)
function snapshot(): CardSnapshot {
  const s: CardSnapshot = { title: props.chart.name, type: props.chart.type, icon: props.chart.icon }
  if (props.chart.type === 'kpi') {
    s.valueText = formatMetric(result.value ? kpiValue(result.value) : null, metricFormat.value)
  } else if (props.chart.type === 'table') {
    s.columns = result.value?.columns.map((c) => c.name)
    s.rows = result.value?.rows.slice(0, 50)
  } else if (props.chart.type === 'pivot') {
    const p = result.value ? pivotModel(result.value) : null
    if (p) {
      const t = pivotToTable(p)
      s.columns = t.columns
      s.rows = t.rows
    }
  } else {
    s.image = renderRef.value?.image() ?? null
  }
  return s
}
defineExpose({ snapshot })
</script>

<template>
  <div class="card">
    <div class="card-head">
      <span class="card-title" :title="chart.name">
        <span v-if="chart.encoding.metricId" class="bound" title="Bound to a saved metric">∑</span>
        {{ chart.name }}
      </span>
      <span class="card-meta">{{ chart.type }}</span>
      <div class="card-actions">
        <div class="exp">
          <button class="ic" title="Export data" @click="exportOpen = !exportOpen"><Icon name="download" :size="14" /></button>
          <div v-if="exportOpen" class="exp-menu" @mouseleave="exportOpen = false">
            <button @click="exportData('xlsx')">Excel (.xlsx)</button>
            <button @click="exportData('csv')">CSV</button>
            <button @click="exportData('json')">JSON</button>
          </div>
        </div>
        <button class="ic" title="Refresh" @click="load"><Icon name="refresh" :size="14" /></button>
        <button class="ic" title="Edit" @click="emit('edit', chart)"><Icon name="pencil" :size="14" /></button>
        <button
          v-if="removable"
          class="ic"
          title="Remove from dashboard"
          @click="emit('removeFromDashboard', chart)"
        ><Icon name="x" :size="14" /></button>
        <button v-else class="ic" title="Delete" @click="emit('remove', chart)"><Icon name="trash" :size="14" /></button>
      </div>
    </div>
    <div class="card-body">
      <div v-if="loading" class="cstate">Loading…</div>
      <div v-else-if="error" class="cstate err">{{ error }}</div>
      <ChartRender
        v-else
        ref="renderRef"
        :type="chart.type"
        :result="result"
        :label="chart.name"
        :icon="chart.icon"
        :format="metricFormat"
        :hide-label="chart.type === 'kpi'"
        @drill="onDrill"
      />
    </div>
    <div v-if="canDrill && !loading && !error" class="drill-hint">Click to drill into the underlying rows</div>

    <!-- drill-through rows -->
    <Modal
      v-if="drillOpen"
      :title="`Records · ${drillTitle}`"
      wide
      @close="drillOpen = false"
    >
      <div class="drill">
        <div v-if="drillLoading" class="cstate">Loading rows…</div>
        <div v-else-if="drillError" class="cstate err">{{ drillError }}</div>
        <div v-else-if="!drillRows || !drillRows.rows.length" class="cstate">No rows.</div>
        <div v-else class="drill-table">
          <div class="drill-count">{{ drillRows.rows.length }} row{{ drillRows.rows.length === 1 ? '' : 's' }}</div>
          <table>
            <thead>
              <tr><th v-for="c in drillRows.columns" :key="c.name">{{ c.name }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(r, ri) in drillRows.rows" :key="ri">
                <td v-for="(cell, ci) in r" :key="ci">{{ cell === null ? 'NULL' : String(cell) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  overflow: hidden;
  min-height: 260px;
  box-shadow: var(--shadow-card);
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.08s;
}
.card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-card-hover);
  transform: translateY(-1px);
}
.card:hover .card-actions {
  opacity: 1;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-meta {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-faint);
  text-transform: lowercase;
  letter-spacing: 0.03em;
}
.bound {
  color: var(--accent);
  font-weight: 700;
  margin-right: 2px;
}
.card-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.exp {
  position: relative;
}
.exp-menu {
  position: absolute;
  top: 24px;
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 120px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}
.exp-menu button {
  text-align: left;
  padding: 7px 11px;
  font-size: 12.5px;
  color: var(--text);
  background: transparent;
}
.exp-menu button:hover {
  background: var(--bg-hover);
}
.ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  padding: 4px 6px;
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
.drill-hint {
  font-size: 10.5px;
  color: var(--text-faint);
  text-align: center;
  padding: 2px 0 5px;
}
.drill {
  min-width: 520px;
  max-height: 60vh;
  overflow: auto;
}
.drill-count {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 8px;
}
.drill-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.drill-table th,
.drill-table td {
  text-align: left;
  padding: 5px 9px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  color: var(--text);
}
.drill-table th {
  position: sticky;
  top: 0;
  background: var(--bg-panel);
  color: var(--text-dim);
  font-weight: 600;
}
</style>
