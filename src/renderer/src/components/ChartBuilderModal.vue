<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import type {
  AnalyticsChart,
  AnalyticsDataset,
  Aggregation,
  ChartType,
  QueryResult,
  TimeBucket
} from '@shared/types'
import { useAnalytics } from '../stores/analytics'
import { buildChartSql, previewSql, datasetRowsSql } from '../lib/analyticsSql'
import Modal from './Modal.vue'
import ChartRender from './ChartRender.vue'

const props = defineProps<{
  connectionId: string
  driver: string
  datasets: AnalyticsDataset[]
  editing?: AnalyticsChart | null
  initialType?: ChartType
}>()
const emit = defineEmits<{ close: []; saved: [chart: AnalyticsChart] }>()

const analytics = useAnalytics()

const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: 'bar', label: 'Bar' },
  { value: 'hbar', label: 'Horizontal bar' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Pie' },
  { value: 'donut', label: 'Donut' },
  { value: 'kpi', label: 'KPI card' },
  { value: 'table', label: 'Table' },
  { value: 'pivot', label: 'Pivot table' }
]
const AGGS: Aggregation[] = ['count', 'sum', 'avg', 'min', 'max']
const BUCKETS: TimeBucket[] = ['none', 'day', 'week', 'month', 'quarter', 'year']

const name = ref(props.editing?.name ?? '')
const datasetId = ref(props.editing?.datasetId ?? props.datasets[0]?.id ?? '')
const type = ref<ChartType>(props.editing?.type ?? props.initialType ?? 'bar')
const icon = ref(props.editing?.icon ?? '')
const metricId = ref(props.editing?.encoding.metricId ?? '')
const availableMetrics = computed(() =>
  analytics.metricsFor(props.connectionId).filter((m) => m.datasetId === datasetId.value)
)
const boundMetric = computed(() =>
  metricId.value ? analytics.getMetric(metricId.value) : undefined
)
const ICONS = ['💰', '📈', '📉', '🛒', '👥', '📦', '⭐', '⚡', '🔥', '✅', '⏱️', '🌍']
const enc = reactive({
  x: props.editing?.encoding.x ?? '',
  bucket: (props.editing?.encoding.bucket ?? 'none') as TimeBucket,
  yAgg: (props.editing?.encoding.yAgg ?? 'count') as Aggregation,
  yColumn: props.editing?.encoding.yColumn ?? '',
  series: props.editing?.encoding.series ?? '',
  limit: props.editing?.encoding.limit ?? 200
})

const columns = ref<string[]>([])
const colError = ref('')
const preview = ref<QueryResult | null>(null)
const previewError = ref('')
const loading = ref(false)
const saving = ref(false)

const selectedDataset = computed(() => props.datasets.find((d) => d.id === datasetId.value))
const isKpi = computed(() => type.value === 'kpi')
const isTable = computed(() => type.value === 'table')
const needsValueCol = computed(() => enc.yAgg !== 'count')

function buildEncoding() {
  const m = boundMetric.value
  return {
    x: isKpi.value || isTable.value ? undefined : enc.x || undefined,
    bucket: enc.bucket,
    // When bound to a metric, the measure comes from it (so preview matches render).
    yAgg: m ? m.agg : enc.yAgg,
    yColumn: m ? m.column : needsValueCol.value ? enc.yColumn || undefined : undefined,
    series: isKpi.value || isTable.value ? undefined : enc.series || undefined,
    limit: enc.limit,
    metricId: m ? m.id : undefined
  }
}

async function loadColumns(): Promise<void> {
  const ds = selectedDataset.value
  if (!ds) return
  colError.value = ''
  try {
    const res = await window.api.db.query(props.connectionId, previewSql(props.driver, ds.source))
    columns.value = res.columns.map((c) => c.name)
    if (!enc.x && columns.value.length) enc.x = columns.value[0]
  } catch (e) {
    colError.value = e instanceof Error ? e.message : String(e)
    columns.value = []
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
function schedulePreview(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(runPreview, 300)
}
async function runPreview(): Promise<void> {
  const ds = selectedDataset.value
  if (!ds) return
  if (isTable.value) {
    // Table just shows the dataset rows (capped).
    loading.value = true
    previewError.value = ''
    try {
      const res = await window.api.db.query(props.connectionId, datasetRowsSql(props.driver, ds.source))
      preview.value = res
    } catch (e) {
      previewError.value = e instanceof Error ? e.message : String(e)
      preview.value = null
    } finally {
      loading.value = false
    }
    return
  }
  if (!isKpi.value && !enc.x) return
  if (!boundMetric.value && needsValueCol.value && !enc.yColumn) return
  loading.value = true
  previewError.value = ''
  try {
    const sql = buildChartSql(props.driver, ds.source, buildEncoding())
    preview.value = await window.api.db.query(props.connectionId, sql)
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e)
    preview.value = null
  } finally {
    loading.value = false
  }
}
watch(datasetId, async () => {
  enc.x = ''
  metricId.value = '' // metrics are dataset-scoped
  await loadColumns()
  schedulePreview()
})
watch(
  [type, metricId, () => enc.x, () => enc.bucket, () => enc.yAgg, () => enc.yColumn, () => enc.series, () => enc.limit],
  schedulePreview
)

onMounted(async () => {
  await loadColumns()
  schedulePreview()
})

const canSave = computed(() => !!name.value.trim() && !!datasetId.value)
async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    const chart = await analytics.saveChart({
      id: props.editing?.id,
      connectionId: props.connectionId,
      datasetId: datasetId.value,
      name: name.value.trim(),
      type: type.value,
      encoding: buildEncoding(),
      icon: type.value === 'kpi' ? icon.value || undefined : undefined
    })
    emit('saved', chart)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal :title="editing ? 'Edit chart' : 'New chart'" wide @close="emit('close')">
    <div class="builder">
      <!-- left: configuration -->
      <div class="config">
        <label class="fld">
          <span>Name</span>
          <input v-model="name" class="input" placeholder="Revenue by month" />
        </label>

        <label class="fld">
          <span>Dataset</span>
          <select v-model="datasetId" class="input">
            <option v-for="d in datasets" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
        </label>
        <p v-if="!datasets.length" class="warn">Create a dataset first.</p>
        <p v-if="colError" class="warn">{{ colError }}</p>

        <label class="fld">
          <span>Chart type</span>
          <select v-model="type" class="input">
            <option v-for="t in CHART_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
          </select>
        </label>

        <label v-if="!isTable && availableMetrics.length" class="fld">
          <span>Measure source</span>
          <select v-model="metricId" class="input">
            <option value="">Define manually below</option>
            <option v-for="m in availableMetrics" :key="m.id" :value="m.id">
              Saved metric · {{ m.name }}
            </option>
          </select>
        </label>

        <div v-if="type === 'kpi'" class="fld">
          <span>Card icon</span>
          <div class="icons">
            <button
              type="button"
              class="icon-opt"
              :class="{ on: !icon }"
              title="No icon"
              @click="icon = ''"
            >∅</button>
            <button
              v-for="ic in ICONS"
              :key="ic"
              type="button"
              class="icon-opt"
              :class="{ on: icon === ic }"
              @click="icon = ic"
            >{{ ic }}</button>
            <input v-model="icon" class="input icon-input" maxlength="2" placeholder="🙂" />
          </div>
        </div>

        <template v-if="!isTable">
          <p v-if="boundMetric" class="metric-note">
            Measure from saved metric <strong>{{ boundMetric.name }}</strong>
            ({{ boundMetric.agg.toUpperCase() }}{{ boundMetric.column ? ' of ' + boundMetric.column : '' }}).
            Edit the metric to change it everywhere.
          </p>
          <div v-else class="row">
            <label class="fld">
              <span>Measure</span>
              <select v-model="enc.yAgg" class="input">
                <option v-for="a in AGGS" :key="a" :value="a">{{ a.toUpperCase() }}</option>
              </select>
            </label>
            <label v-if="needsValueCol" class="fld">
              <span>Of column</span>
              <select v-model="enc.yColumn" class="input">
                <option value="">—</option>
                <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>
          </div>

          <template v-if="!isKpi">
            <label class="fld">
              <span>{{ type === 'pivot' ? 'Rows' : 'Group by (X axis)' }}</span>
              <select v-model="enc.x" class="input">
                <option value="">—</option>
                <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>
            <div class="row">
              <label class="fld">
                <span>Time bucket</span>
                <select v-model="enc.bucket" class="input">
                  <option v-for="b in BUCKETS" :key="b" :value="b">{{ b }}</option>
                </select>
              </label>
              <label class="fld">
                <span>{{ type === 'pivot' ? 'Columns' : 'Split series' }}</span>
                <select v-model="enc.series" class="input">
                  <option value="">none</option>
                  <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
                </select>
              </label>
            </div>
            <label class="fld">
              <span>Row limit</span>
              <input v-model.number="enc.limit" type="number" min="1" class="input" />
            </label>
          </template>
        </template>
      </div>

      <!-- right: live preview -->
      <div class="preview">
        <div class="preview-head">Preview</div>
        <div class="preview-body">
          <div v-if="loading" class="pv-state">Running…</div>
          <div v-else-if="previewError" class="pv-state err">{{ previewError }}</div>
          <ChartRender v-else :type="type" :result="preview" :label="name || 'Value'" :icon="type === 'kpi' ? icon : ''" />
        </div>
      </div>
    </div>

    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canSave || saving" @click="save">
        {{ saving ? 'Saving…' : editing ? 'Save changes' : 'Create chart' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.builder {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 18px;
  min-height: 420px;
}
.config {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
  flex: 1;
}
.fld > span {
  font-weight: 600;
}
.row {
  display: flex;
  gap: 10px;
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
.icons {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.icon-opt {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-dim);
}
.icon-opt:hover {
  border-color: var(--accent-soft);
}
.icon-opt.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.icon-input {
  width: 44px;
  text-align: center;
  padding: 4px;
}
.warn {
  font-size: 11.5px;
  color: var(--danger);
  margin: 0;
}
.metric-note {
  font-size: 11.5px;
  color: var(--text-dim);
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--accent-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}
.preview {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-app);
}
.preview-head {
  padding: 7px 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-faint);
  font-weight: 700;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.preview-body {
  flex: 1;
  min-height: 380px;
  position: relative;
}
.pv-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-dim);
  font-size: 13px;
}
.pv-state.err {
  color: var(--danger);
  padding: 16px;
  text-align: center;
}
</style>
