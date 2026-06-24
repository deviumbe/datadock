<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { GridLayout, GridItem } from 'grid-layout-plus'
import type {
  AnalyticsChart,
  AnalyticsDashboard,
  DashboardFilter,
  DashboardFilterType,
  FilterSpec
} from '@shared/types'
import { useAnalytics } from '../stores/analytics'
import { buildReportHtml, type CardSnapshot } from '../lib/reportHtml'
import ChartCard from './ChartCard.vue'

const props = defineProps<{ dashboard: AnalyticsDashboard; connId: string; driver: string }>()
const emit = defineEmits<{ back: [] }>()

const analytics = useAnalytics()

interface LayoutItem {
  i: string // chartId
  x: number
  y: number
  w: number
  h: number
}
const layout = ref<LayoutItem[]>(
  props.dashboard.widgets.map((w) => ({ i: w.chartId, x: w.x, y: w.y, w: w.w, h: w.h }))
)
const name = ref(props.dashboard.name)
const filters = ref<DashboardFilter[]>(props.dashboard.filters ? [...props.dashboard.filters] : [])
const refreshSec = ref<number>(props.dashboard.refreshSec ?? 0)

// Charts available to add = this connection's charts not already on the board.
const onBoard = computed(() => new Set(layout.value.map((l) => l.i)))
const available = computed(() =>
  analytics.chartsFor(props.connId).filter((c) => !onBoard.value.has(c.id))
)

let timer: ReturnType<typeof setTimeout> | null = null
function persist(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void analytics.saveDashboard({
      id: props.dashboard.id,
      connectionId: props.connId,
      name: name.value.trim() || 'Dashboard',
      widgets: layout.value.map((l) => ({ chartId: l.i, x: l.x, y: l.y, w: l.w, h: l.h })),
      filters: filters.value,
      refreshSec: refreshSec.value
    })
  }, 500)
}

function onLayoutUpdated(): void {
  persist()
}

function addWidget(chartId: string): void {
  if (!chartId || onBoard.value.has(chartId)) return
  const maxY = layout.value.reduce((m, l) => Math.max(m, l.y + l.h), 0)
  layout.value = [...layout.value, { i: chartId, x: 0, y: maxY, w: 6, h: 8 }]
  persist()
}
function removeWidget(chart: AnalyticsChart): void {
  layout.value = layout.value.filter((l) => l.i !== chart.id)
  persist()
}

const addPick = ref('')
watch(addPick, (id) => {
  if (id) {
    addWidget(id)
    addPick.value = ''
  }
})
watch(name, persist)

async function deleteDashboard(): Promise<void> {
  if (confirm(`Delete dashboard “${props.dashboard.name}”? (Charts are kept.)`)) {
    await analytics.removeDashboard(props.dashboard.id)
    emit('back')
  }
}

// ---- column-aware dashboard filters ----------------------------------------
// Cache of each on-board chart's dataset columns, so a filter is only applied to
// widgets whose dataset actually has the targeted column.
const datasetCols = ref<Map<string, string[]>>(new Map())
watch(
  () => layout.value.map((l) => l.i).join(','),
  async () => {
    const seen = new Map(datasetCols.value)
    for (const item of layout.value) {
      const chart = analytics.getChart(item.i)
      if (!chart || seen.has(chart.datasetId)) continue
      seen.set(chart.datasetId, await analytics.ensureColumns(props.connId, props.driver, chart.datasetId))
    }
    datasetCols.value = seen
  },
  { immediate: true }
)

/** All columns across on-board datasets — choices when adding a filter. */
const allColumns = computed(() => {
  const set = new Set<string>()
  for (const cols of datasetCols.value.values()) cols.forEach((c) => set.add(c))
  return [...set].sort()
})

/** Compile an active filter into FilterSpec(s). */
function filterSpecs(f: DashboardFilter): FilterSpec[] {
  if (f.type === 'daterange') {
    const out: FilterSpec[] = []
    if (f.from) out.push({ column: f.column, op: '>=', value: f.from })
    if (f.to) out.push({ column: f.column, op: '<=', value: f.to })
    return out
  }
  if (!f.value) return []
  return [{ column: f.column, op: f.type === 'text' ? 'contains' : '=', value: f.value }]
}

// Shared reference for "no filters" so unaffected widgets don't reload when an
// unrelated filter changes (a fresh [] each time would change the prop identity).
const NO_FILTERS: FilterSpec[] = []

/**
 * Active filter specs per dataset, recomputed only when the filters or the known
 * dataset columns change — not on drag or realtime ticks. Column-aware: a filter
 * only applies to a dataset that actually has its column.
 */
const filtersByDataset = computed(() => {
  const map = new Map<string, FilterSpec[]>()
  for (const [datasetId, cols] of datasetCols.value) {
    const out: FilterSpec[] = []
    for (const f of filters.value) {
      if (!cols.includes(f.column)) continue
      out.push(...filterSpecs(f))
    }
    map.set(datasetId, out.length ? out : NO_FILTERS)
  }
  return map
})
function filtersForChart(chart: AnalyticsChart): FilterSpec[] {
  return filtersByDataset.value.get(chart.datasetId) ?? NO_FILTERS
}

// add-filter form
const addingFilter = ref(false)
const nf = ref<{ label: string; column: string; type: DashboardFilterType }>({
  label: '',
  column: '',
  type: 'text'
})
function startAddFilter(): void {
  nf.value = { label: '', column: allColumns.value[0] ?? '', type: 'text' }
  addingFilter.value = true
}
function confirmAddFilter(): void {
  if (!nf.value.column) return
  filters.value = [
    ...filters.value,
    {
      id: `f_${Date.now().toString(36)}`,
      label: nf.value.label.trim() || nf.value.column,
      column: nf.value.column,
      type: nf.value.type
    }
  ]
  addingFilter.value = false
  persist()
}
function removeFilter(id: string): void {
  filters.value = filters.value.filter((f) => f.id !== id)
  persist()
}
function onFilterInput(): void {
  persist()
}

// ---- realtime auto-refresh -------------------------------------------------
const tick = ref(0)
let rtTimer: ReturnType<typeof setInterval> | null = null
const REFRESH_OPTS = [
  { v: 0, label: 'Off' },
  { v: 5, label: '5s' },
  { v: 15, label: '15s' },
  { v: 30, label: '30s' },
  { v: 60, label: '1m' },
  { v: 300, label: '5m' }
]
function applyRealtime(): void {
  if (rtTimer) {
    clearInterval(rtTimer)
    rtTimer = null
  }
  if (refreshSec.value > 0) {
    rtTimer = setInterval(() => (tick.value += 1), refreshSec.value * 1000)
  }
}
watch(refreshSec, () => {
  applyRealtime()
  persist()
})
applyRealtime()
onBeforeUnmount(() => {
  if (rtTimer) clearInterval(rtTimer)
})

// ---- PDF export ------------------------------------------------------------
const cardRefs = new Map<string, InstanceType<typeof ChartCard>>()
function setCard(id: string, el: unknown): void {
  if (el) cardRefs.set(id, el as InstanceType<typeof ChartCard>)
  else cardRefs.delete(id)
}
const exporting = ref(false)
async function exportPdf(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const snaps: CardSnapshot[] = []
    for (const item of layout.value) {
      const card = cardRefs.get(item.i)
      if (card?.snapshot) snaps.push(card.snapshot())
    }
    const sub = filters.value
      .map((f) => {
        const v = f.type === 'daterange' ? [f.from, f.to].filter(Boolean).join(' → ') : f.value
        return v ? `${f.label}: ${v}` : ''
      })
      .filter(Boolean)
      .join('   ·   ')
    const html = buildReportHtml(name.value || 'Dashboard', snaps, sub || undefined)
    await window.api.io.exportPdf(`${(name.value || 'dashboard').replace(/[^\w.-]+/g, '_')}.pdf`, html)
  } finally {
    exporting.value = false
  }
}

// ---- in-context AI (fix/change charts on this dashboard) ----
const aiPrompt = ref('')
const aiBusy = ref(false)
const aiError = ref('')
const aiNote = ref('')
const aiHasKey = ref(true)
window.api.ai.hasKey().then((v) => (aiHasKey.value = v)).catch(() => (aiHasKey.value = false))

async function askAi(): Promise<void> {
  const p = aiPrompt.value.trim()
  if (!p || aiBusy.value) return
  aiBusy.value = true
  aiError.value = ''
  aiNote.value = ''
  try {
    const r = await analytics.runAi(props.connId, props.driver, p)
    aiNote.value = (r.notes ? r.notes + ' ' : '') + r.summary
    aiPrompt.value = ''
    // The AI may have changed this dashboard's layout/charts — re-sync from store.
    const updated = analytics.getDashboard(props.dashboard.id)
    if (updated) {
      layout.value = updated.widgets.map((w) => ({ i: w.chartId, x: w.x, y: w.y, w: w.w, h: w.h }))
      name.value = updated.name
    }
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e)
  } finally {
    aiBusy.value = false
  }
}
</script>

<template>
  <div class="dash">
    <header class="dash-head">
      <button class="btn btn-ghost" title="Back to Analytics" @click="emit('back')">‹ Back</button>
      <input v-model="name" class="dash-name" />
      <div class="spacer" />
      <label class="rt">
        <span class="rt-dot" :class="{ on: refreshSec > 0 }" />
        <select v-model.number="refreshSec" class="add-select" title="Auto-refresh interval">
          <option v-for="o in REFRESH_OPTS" :key="o.v" :value="o.v">
            {{ o.v === 0 ? 'Realtime: Off' : 'Every ' + o.label }}
          </option>
        </select>
      </label>
      <select v-if="available.length" v-model="addPick" class="add-select">
        <option value="">＋ Add chart…</option>
        <option v-for="c in available" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <span v-else class="no-add">All charts added</span>
      <button class="btn btn-ghost" :disabled="exporting || !layout.length" @click="exportPdf">
        {{ exporting ? 'Exporting…' : 'Export PDF' }}
      </button>
      <button class="btn btn-ghost danger" @click="deleteDashboard">Delete</button>
    </header>

    <!-- Filter bar -->
    <div class="filter-bar">
      <span class="fb-label">Filters</span>
      <div v-for="f in filters" :key="f.id" class="fchip">
        <span class="fchip-label">{{ f.label }}</span>
        <template v-if="f.type === 'daterange'">
          <input v-model="f.from" type="date" class="fchip-input" @change="onFilterInput" />
          <span class="fchip-sep">→</span>
          <input v-model="f.to" type="date" class="fchip-input" @change="onFilterInput" />
        </template>
        <input
          v-else
          v-model="f.value"
          class="fchip-input"
          :placeholder="f.type === 'text' ? 'contains…' : 'equals…'"
          @input="onFilterInput"
        />
        <button class="fchip-x" title="Remove filter" @click="removeFilter(f.id)">✕</button>
      </div>

      <div v-if="addingFilter" class="add-filter">
        <input v-model="nf.label" class="fchip-input" placeholder="Label" />
        <select v-model="nf.column" class="fchip-input">
          <option v-for="c in allColumns" :key="c" :value="c">{{ c }}</option>
        </select>
        <select v-model="nf.type" class="fchip-input">
          <option value="text">contains</option>
          <option value="select">equals</option>
          <option value="daterange">date range</option>
        </select>
        <button class="btn btn-primary sm" @click="confirmAddFilter">Add</button>
        <button class="btn btn-ghost sm" @click="addingFilter = false">Cancel</button>
      </div>
      <button v-else class="btn btn-ghost sm" :disabled="!allColumns.length" @click="startAddFilter">
        ＋ Filter
      </button>
    </div>

    <div class="ai-bar">
      <span class="ai-ic">✨</span>
      <input
        v-model="aiPrompt"
        class="ai-input"
        :disabled="aiBusy || !aiHasKey"
        placeholder="Ask AI to change this dashboard — e.g. “fix the revenue chart” or “add a KPI for total orders”"
        @keydown.enter="askAi"
      />
      <button class="btn btn-primary" :disabled="aiBusy || !aiPrompt.trim() || !aiHasKey" @click="askAi">
        {{ aiBusy ? 'Working…' : 'Ask AI' }}
      </button>
    </div>
    <p v-if="!aiHasKey" class="ai-note">Configure an AI provider in Settings (⌘,) to edit with AI.</p>
    <p v-else-if="aiError" class="ai-note err">{{ aiError }}</p>
    <p v-else-if="aiNote" class="ai-note ok">{{ aiNote }}</p>

    <div class="dash-body">
      <div v-if="!layout.length" class="empty">
        Empty dashboard. Use <strong>＋ Add chart</strong> above to place charts, then drag their
        title bars to move and drag the bottom-right corner to resize.
      </div>
      <GridLayout
        v-else
        v-model:layout="layout"
        :col-num="12"
        :row-height="30"
        :margin="[12, 12]"
        :is-draggable="true"
        :is-resizable="true"
        :vertical-compact="true"
        :use-css-transforms="true"
        drag-allow-from=".card-head"
        @layout-updated="onLayoutUpdated"
      >
        <GridItem
          v-for="item in layout"
          :key="item.i"
          :x="item.x"
          :y="item.y"
          :w="item.w"
          :h="item.h"
          :i="item.i"
        >
          <ChartCard
            v-if="analytics.getChart(item.i)"
            :ref="(el) => setCard(item.i, el)"
            :chart="analytics.getChart(item.i)!"
            :dataset="analytics.getDataset(analytics.getChart(item.i)!.datasetId)"
            :connection-id="connId"
            :driver="driver"
            :extra-filters="filtersForChart(analytics.getChart(item.i)!)"
            :refresh-key="tick"
            removable
            @edit="() => {}"
            @remove-from-dashboard="removeWidget"
          />
          <div v-else class="missing">Chart was deleted</div>
        </GridItem>
      </GridLayout>
    </div>
  </div>
</template>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
}
.dash-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.dash-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  outline: none;
  min-width: 220px;
}
.dash-name:hover {
  border-color: var(--border);
}
.dash-name:focus {
  border-color: var(--accent);
  background: var(--bg-input);
}
.spacer {
  flex: 1;
}
.rt {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rt-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
}
.rt-dot.on {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.filter-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.fb-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-faint);
  font-weight: 700;
}
.fchip,
.add-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
}
.fchip-label {
  font-size: 12px;
  color: var(--text-dim);
  font-weight: 600;
}
.fchip-sep {
  color: var(--text-faint);
}
.fchip-input {
  font-size: 12px;
  padding: 4px 7px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  outline: none;
}
.fchip-input:focus {
  border-color: var(--accent);
}
.fchip-x {
  font-size: 11px;
  color: var(--text-faint);
  padding: 2px 5px;
  border-radius: var(--radius-sm);
}
.fchip-x:hover {
  background: var(--bg-hover);
  color: var(--danger);
}
.btn.sm {
  font-size: 12px;
  padding: 4px 9px;
}
.ai-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-app);
}
.ai-ic {
  font-size: 15px;
}
.ai-input {
  flex: 1;
  font-size: 13px;
  padding: 7px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  outline: none;
}
.ai-input:focus {
  border-color: var(--accent);
}
.ai-note {
  margin: 0;
  padding: 6px 16px;
  font-size: 12px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.ai-note.err {
  color: var(--danger);
}
.ai-note.ok {
  color: var(--accent);
}
.add-select {
  font-size: 13px;
  padding: 6px 9px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  outline: none;
}
.no-add {
  font-size: 12px;
  color: var(--text-faint);
}
.danger:hover {
  color: var(--danger);
}
.dash-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px 40px;
}
.empty {
  margin: 40px auto;
  max-width: 460px;
  text-align: center;
  font-size: 13px;
  color: var(--text-dim);
  padding: 24px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}
/* Each widget fills its grid cell; ChartCard already has its own chrome. */
.dash-body :deep(.vgl-item) {
  touch-action: none;
}
.dash-body :deep(.card) {
  height: 100%;
  min-height: 0;
}
.dash-body :deep(.card-head) {
  cursor: move;
}
.dash-body :deep(.vgl-item__resizer) {
  z-index: 2;
}
.missing {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-faint);
  font-size: 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}
</style>
