<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import type { AnalyticsDataset, AnalyticsMetric, Aggregation, MetricFormat } from '@shared/types'
import { useAnalytics } from '../stores/analytics'
import { buildChartSql, previewSql } from '../lib/analyticsSql'
import { kpiValue, formatMetric } from '../lib/chartOption'
import Modal from './Modal.vue'

const props = defineProps<{
  connectionId: string
  driver: string
  datasets: AnalyticsDataset[]
  editing?: AnalyticsMetric | null
}>()
const emit = defineEmits<{ close: []; saved: [metric: AnalyticsMetric] }>()

const analytics = useAnalytics()

const AGGS: Aggregation[] = ['count', 'sum', 'avg', 'min', 'max']
const STYLES: MetricFormat['style'][] = ['plain', 'currency', 'percent']
const ICONS = ['💰', '📈', '📉', '🛒', '👥', '📦', '⭐', '⚡', '🔥', '✅', '⏱️', '🌍']

const name = ref(props.editing?.name ?? '')
const datasetId = ref(props.editing?.datasetId ?? props.datasets[0]?.id ?? '')
const agg = ref<Aggregation>(props.editing?.agg ?? 'count')
const column = ref(props.editing?.column ?? '')
const icon = ref(props.editing?.icon ?? '')
const fmt = reactive<MetricFormat>({
  style: props.editing?.format?.style ?? 'plain',
  decimals: props.editing?.format?.decimals ?? 0,
  prefix: props.editing?.format?.prefix ?? '',
  suffix: props.editing?.format?.suffix ?? ''
})

const columns = ref<string[]>([])
const colError = ref('')
const value = ref<number | null>(null)
const previewError = ref('')
const loading = ref(false)

const selectedDataset = computed(() => props.datasets.find((d) => d.id === datasetId.value))
const needsCol = computed(() => agg.value !== 'count')
const formatObj = computed<MetricFormat>(() => ({
  style: fmt.style,
  decimals: fmt.decimals,
  prefix: fmt.prefix || undefined,
  suffix: fmt.suffix || undefined
}))
const previewText = computed(() => formatMetric(value.value, formatObj.value))

async function loadColumns(): Promise<void> {
  const ds = selectedDataset.value
  if (!ds) return
  colError.value = ''
  try {
    const res = await window.api.db.query(props.connectionId, previewSql(props.driver, ds.source))
    columns.value = res.columns.map((c) => c.name)
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
  if (needsCol.value && !column.value) return
  loading.value = true
  previewError.value = ''
  try {
    const sql = buildChartSql(props.driver, ds.source, {
      yAgg: agg.value,
      yColumn: needsCol.value ? column.value : undefined,
      filters: props.editing?.filters
    })
    const res = await window.api.db.query(props.connectionId, sql)
    value.value = kpiValue(res)
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e)
    value.value = null
  } finally {
    loading.value = false
  }
}

watch(datasetId, async () => {
  column.value = ''
  await loadColumns()
  schedulePreview()
})
watch([agg, column, () => fmt.style, () => fmt.decimals, () => fmt.prefix, () => fmt.suffix], schedulePreview)
onMounted(async () => {
  await loadColumns()
  schedulePreview()
})

const canSave = computed(() => !!name.value.trim() && !!datasetId.value && (!needsCol.value || !!column.value))
const saving = ref(false)
async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    const metric = await analytics.saveMetric({
      id: props.editing?.id,
      connectionId: props.connectionId,
      datasetId: datasetId.value,
      name: name.value.trim(),
      agg: agg.value,
      column: needsCol.value ? column.value : undefined,
      filters: props.editing?.filters,
      format: formatObj.value,
      icon: icon.value || undefined
    })
    emit('saved', metric)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal :title="editing ? 'Edit metric' : 'New metric'" wide @close="emit('close')">
    <div class="builder">
      <div class="config">
        <label class="fld">
          <span>Name</span>
          <input v-model="name" class="input" placeholder="Total revenue" />
        </label>
        <label class="fld">
          <span>Dataset</span>
          <select v-model="datasetId" class="input">
            <option v-for="d in datasets" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
        </label>
        <p v-if="!datasets.length" class="warn">Create a dataset first.</p>
        <p v-if="colError" class="warn">{{ colError }}</p>

        <div class="row">
          <label class="fld">
            <span>Measure</span>
            <select v-model="agg" class="input">
              <option v-for="a in AGGS" :key="a" :value="a">{{ a.toUpperCase() }}</option>
            </select>
          </label>
          <label v-if="needsCol" class="fld">
            <span>Of column</span>
            <select v-model="column" class="input">
              <option value="">—</option>
              <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
        </div>

        <div class="row">
          <label class="fld">
            <span>Format</span>
            <select v-model="fmt.style" class="input">
              <option v-for="s in STYLES" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
          <label class="fld">
            <span>Decimals</span>
            <input v-model.number="fmt.decimals" type="number" min="0" max="6" class="input" />
          </label>
        </div>
        <div class="row">
          <label class="fld">
            <span>Prefix</span>
            <input v-model="fmt.prefix" class="input" placeholder="$" />
          </label>
          <label class="fld">
            <span>Suffix</span>
            <input v-model="fmt.suffix" class="input" placeholder=" orders" />
          </label>
        </div>

        <div class="fld">
          <span>Icon</span>
          <div class="icons">
            <button type="button" class="icon-opt" :class="{ on: !icon }" title="No icon" @click="icon = ''">∅</button>
            <button
              v-for="ic in ICONS"
              :key="ic"
              type="button"
              class="icon-opt"
              :class="{ on: icon === ic }"
              @click="icon = ic"
            >{{ ic }}</button>
          </div>
        </div>
      </div>

      <div class="preview">
        <div class="preview-head">Preview</div>
        <div class="preview-body">
          <div v-if="loading" class="pv-state">Running…</div>
          <div v-else-if="previewError" class="pv-state err">{{ previewError }}</div>
          <div v-else class="kpi">
            <div class="kpi-top">
              <span v-if="icon" class="kpi-chip">{{ icon }}</span>
              <span class="kpi-label">{{ name || 'Value' }}</span>
            </div>
            <span class="kpi-value">{{ previewText }}</span>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canSave || saving" @click="save">
        {{ saving ? 'Saving…' : editing ? 'Save changes' : 'Create metric' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.builder {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 18px;
  min-height: 360px;
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
.icon-opt.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.warn {
  font-size: 11.5px;
  color: var(--danger);
  margin: 0;
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
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}
.pv-state.err {
  color: var(--danger);
  padding: 16px;
  text-align: center;
}
.kpi {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 24px;
}
.kpi-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.kpi-chip {
  width: 34px;
  height: 34px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
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
}
.kpi-value {
  font-family: var(--font-display);
  font-size: 40px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
  line-height: 1;
}
</style>
