<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import type { AnalyticsChart, ChartType, DatasetSource } from '@shared/types'
import { useAnalytics } from '../stores/analytics'
import { useWorkspace } from '../stores/workspace'
import Modal from './Modal.vue'
import ChartCard from './ChartCard.vue'
import ChartBuilderModal from './ChartBuilderModal.vue'
import DashboardView from './DashboardView.vue'

const props = defineProps<{ connId: string; driver: string }>()

const analytics = useAnalytics()
const ws = useWorkspace()

const isSql = computed(() => ['postgres', 'mysql', 'sqlite', 'mssql'].includes(props.driver))
const datasets = computed(() => analytics.datasetsFor(props.connId))
const charts = computed(() => analytics.chartsFor(props.connId))
const dashboardList = computed(() => analytics.dashboardsFor(props.connId))

// When set, the panel shows that dashboard's grid instead of the hub.
const openDashboardId = ref('')
const openDashboard = computed(() =>
  openDashboardId.value ? analytics.getDashboard(openDashboardId.value) : undefined
)
async function newDashboard(): Promise<void> {
  const saved = await analytics.saveDashboard({
    connectionId: props.connId,
    name: 'New dashboard',
    widgets: []
  })
  openDashboardId.value = saved.id
}
async function deleteDashboard(id: string, dname: string): Promise<void> {
  if (confirm(`Delete dashboard “${dname}”? (Charts are kept.)`)) await analytics.removeDashboard(id)
}

watch(
  () => props.connId,
  (id) => {
    if (id && isSql.value) void analytics.loadFor(id)
  },
  { immediate: true }
)

// ---- AI dashboard builder ----
const aiPrompt = ref('')
const aiBusy = ref(false)
const aiError = ref('')
const aiNotes = ref('')
const aiHasKey = ref(true)
window.api.ai.hasKey().then((v) => (aiHasKey.value = v)).catch(() => (aiHasKey.value = false))

async function askAi(): Promise<void> {
  const prompt = aiPrompt.value.trim()
  if (!prompt || aiBusy.value) return
  aiBusy.value = true
  aiError.value = ''
  aiNotes.value = ''
  try {
    const r = await analytics.runAi(props.connId, props.driver, prompt)
    aiNotes.value = (r.notes ? r.notes + ' ' : '') + r.summary
    aiPrompt.value = ''
    // Jump into the dashboard the AI built or changed.
    if (r.focusDashboardId) openDashboardId.value = r.focusDashboardId
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e)
  } finally {
    aiBusy.value = false
  }
}

// ---- chart builder ----
const builderOpen = ref(false)
const editingChart = ref<AnalyticsChart | null>(null)
const builderType = ref<ChartType | undefined>(undefined)
function newChart(initialType?: ChartType): void {
  editingChart.value = null
  builderType.value = initialType
  builderOpen.value = true
}
function editChart(c: AnalyticsChart): void {
  editingChart.value = c
  builderOpen.value = true
}
async function removeChart(c: AnalyticsChart): Promise<void> {
  if (confirm(`Delete chart “${c.name}”?`)) await analytics.removeChart(c.id)
}

// ---- dataset editor ----
const dsOpen = ref(false)
const ds = reactive<{ id?: string; name: string; kind: 'table' | 'view' | 'sql'; table: string; sql: string }>({
  name: '',
  kind: 'table',
  table: '',
  sql: ''
})
const tableOptions = computed(() => ws.tables.filter((t) => t.type !== 'view').map((t) => t.name))
const viewOptions = computed(() => ws.tables.filter((t) => t.type === 'view').map((t) => t.name))

function newDataset(): void {
  ds.id = undefined
  ds.name = ''
  ds.kind = 'table'
  ds.table = tableOptions.value[0] ?? ''
  ds.sql = ''
  dsOpen.value = true
}
const canSaveDs = computed(() => {
  if (!ds.name.trim()) return false
  if (ds.kind === 'sql') return !!ds.sql.trim()
  return !!ds.table
})
async function saveDataset(): Promise<void> {
  if (!canSaveDs.value) return
  let source: DatasetSource
  if (ds.kind === 'sql') source = { kind: 'sql', sql: ds.sql.trim() }
  else if (ds.kind === 'view') source = { kind: 'view', table: ds.table }
  else source = { kind: 'table', table: ds.table }
  await analytics.saveDataset({ id: ds.id, connectionId: props.connId, name: ds.name.trim(), source })
  dsOpen.value = false
}
async function removeDataset(id: string, name: string): Promise<void> {
  if (confirm(`Delete dataset “${name}”? Charts built on it will also be removed.`))
    await analytics.removeDataset(id)
}

function sourceLabel(src: DatasetSource): string {
  return src.kind === 'sql' ? 'Custom SQL' : `${src.kind}: ${src.table}`
}
</script>

<template>
  <!-- Opened dashboard takes over the whole area -->
  <DashboardView
    v-if="openDashboard"
    :dashboard="openDashboard"
    :conn-id="connId"
    :driver="driver"
    @back="openDashboardId = ''"
  />

  <div v-else class="analytics">
    <header class="ahead">
      <div>
        <span class="atitle">Analytics</span>
        <span class="asub">Build charts and dashboards on your data</span>
      </div>
      <div class="aactions">
        <button class="btn btn-ghost" :disabled="!isSql" @click="newDataset">＋ Dataset</button>
        <button class="btn btn-ghost" :disabled="!isSql || !datasets.length" @click="newChart()">＋ Chart</button>
        <button class="btn btn-ghost" :disabled="!isSql || !datasets.length" @click="newChart('kpi')">＋ KPI card</button>
        <button class="btn btn-primary" :disabled="!isSql" @click="newDashboard">＋ Dashboard</button>
      </div>
    </header>

    <div v-if="!isSql" class="state">Analytics isn't available for {{ driver }} yet.</div>

    <div v-else class="abody">
      <!-- AI dashboard builder -->
      <section class="ai-card">
        <div class="ai-row">
          <span class="ai-ic">✨</span>
          <input
            v-model="aiPrompt"
            class="ai-input"
            :disabled="aiBusy || !aiHasKey"
            placeholder="Ask AI to build charts — e.g. “monthly sales by top 10 customers”"
            @keydown.enter="askAi"
          />
          <button class="btn btn-primary" :disabled="aiBusy || !aiPrompt.trim() || !aiHasKey" @click="askAi">
            {{ aiBusy ? 'Building…' : 'Build with AI' }}
          </button>
        </div>
        <p v-if="!aiHasKey" class="ai-hint">Configure an AI provider in Settings (⌘,) to build charts from a prompt.</p>
        <p v-else-if="aiError" class="ai-hint err">{{ aiError }}</p>
        <p v-else-if="aiNotes" class="ai-hint ok">{{ aiNotes }}</p>
      </section>

      <!-- Dashboards -->
      <section class="sect">
        <h3>Dashboards <span class="count">{{ dashboardList.length }}</span></h3>
        <div v-if="!dashboardList.length" class="empty">
          No dashboards yet. Create one and drag charts onto a resizable grid — or ask the AI to build a whole dashboard above.
        </div>
        <div v-else class="ds-list">
          <div v-for="d in dashboardList" :key="d.id" class="ds dash-row" @click="openDashboardId = d.id">
            <span class="ds-name">{{ d.name }}</span>
            <span class="ds-src">{{ d.widgets.length }} chart{{ d.widgets.length === 1 ? '' : 's' }}</span>
            <button class="ic" title="Open" @click.stop="openDashboardId = d.id">↗</button>
            <button class="ic" title="Delete" @click.stop="deleteDashboard(d.id, d.name)">🗑</button>
          </div>
        </div>
      </section>

      <!-- Datasets -->
      <section class="sect">
        <h3>Datasets <span class="count">{{ datasets.length }}</span></h3>
        <div v-if="!datasets.length" class="empty">
          No datasets yet. A dataset is a reusable source (a table, view or saved query) that charts are built on.
        </div>
        <div v-else class="ds-list">
          <div v-for="d in datasets" :key="d.id" class="ds">
            <span class="ds-name">{{ d.name }}</span>
            <span class="ds-src">{{ sourceLabel(d.source) }}</span>
            <button class="ic" title="Delete" @click="removeDataset(d.id, d.name)">🗑</button>
          </div>
        </div>
      </section>

      <!-- Charts -->
      <section class="sect">
        <h3>Charts <span class="count">{{ charts.length }}</span></h3>
        <div v-if="!charts.length" class="empty">
          No charts yet. Create a dataset, then add a chart to visualize it.
        </div>
        <div v-else class="chart-grid">
          <ChartCard
            v-for="c in charts"
            :key="c.id"
            :chart="c"
            :dataset="analytics.getDataset(c.datasetId)"
            :connection-id="connId"
            :driver="driver"
            @edit="editChart"
            @remove="removeChart"
          />
        </div>
      </section>
    </div>

    <!-- Dataset editor -->
    <Modal v-if="dsOpen" :title="ds.id ? 'Edit dataset' : 'New dataset'" @close="dsOpen = false">
      <div class="dsform">
        <label class="fld">
          <span>Name</span>
          <input v-model="ds.name" class="input" placeholder="Orders" />
        </label>
        <label class="fld">
          <span>Source</span>
          <select v-model="ds.kind" class="input">
            <option value="table">Table</option>
            <option value="view">View</option>
            <option value="sql">Custom SQL</option>
          </select>
        </label>
        <label v-if="ds.kind === 'table'" class="fld">
          <span>Table</span>
          <select v-model="ds.table" class="input">
            <option v-for="t in tableOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <label v-else-if="ds.kind === 'view'" class="fld">
          <span>View</span>
          <select v-model="ds.table" class="input">
            <option v-for="t in viewOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <label v-else class="fld">
          <span>SQL query</span>
          <textarea v-model="ds.sql" class="input mono" rows="6" placeholder="SELECT * FROM orders"></textarea>
        </label>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="dsOpen = false">Cancel</button>
        <button class="btn btn-primary" :disabled="!canSaveDs" @click="saveDataset">Save dataset</button>
      </template>
    </Modal>

    <!-- Chart builder -->
    <ChartBuilderModal
      v-if="builderOpen"
      :connection-id="connId"
      :driver="driver"
      :datasets="datasets"
      :editing="editingChart"
      :initial-type="builderType"
      @close="builderOpen = false"
      @saved="builderOpen = false"
    />
  </div>
</template>

<style scoped>
.analytics {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
}
.ahead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.atitle {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}
.asub {
  margin-left: 10px;
  font-size: 12px;
  color: var(--text-faint);
}
.aactions {
  display: flex;
  gap: 8px;
}
.state {
  margin: auto;
  padding: 60px;
  color: var(--text-dim);
  font-size: 13px;
}
.abody {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px 40px;
}
.ai-card {
  margin-bottom: 22px;
  padding: 12px 14px;
  border: 1px solid var(--accent-soft);
  border-radius: var(--radius);
  background: var(--bg-panel);
}
.ai-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ai-ic {
  font-size: 16px;
}
.ai-input {
  flex: 1;
  font-size: 13.5px;
  padding: 9px 11px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  outline: none;
}
.ai-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.ai-hint {
  margin: 8px 2px 0;
  font-size: 12px;
  color: var(--text-dim);
}
.ai-hint.err {
  color: var(--danger);
}
.ai-hint.ok {
  color: var(--accent);
}
.sect {
  margin-bottom: 22px;
}
.sect h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-faint);
  margin: 0 0 10px;
}
.count {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 7px;
  margin-left: 4px;
  color: var(--text-dim);
}
.empty {
  font-size: 12.5px;
  color: var(--text-dim);
  padding: 14px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}
.ds-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ds {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}
.dash-row {
  cursor: pointer;
}
.dash-row:hover {
  border-color: var(--accent-soft);
  background: var(--bg-hover);
}
.ds-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}
.ds-src {
  font-size: 11.5px;
  color: var(--text-faint);
  font-family: var(--mono);
}
.ic {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-faint);
  padding: 3px 6px;
  border-radius: var(--radius-sm);
}
.ic:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.chart-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 14px;
}
.dsform {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 380px;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
}
.fld > span {
  font-weight: 600;
}
.input {
  font-size: 13px;
  padding: 7px 9px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  outline: none;
}
.input:focus {
  border-color: var(--accent);
}
.mono {
  font-family: var(--mono);
  resize: vertical;
}
</style>
