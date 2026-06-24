<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { GridLayout, GridItem } from 'grid-layout-plus'
import type { AnalyticsChart, AnalyticsDashboard } from '@shared/types'
import { useAnalytics } from '../stores/analytics'
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
      widgets: layout.value.map((l) => ({ chartId: l.i, x: l.x, y: l.y, w: l.w, h: l.h }))
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
      <select v-if="available.length" v-model="addPick" class="add-select">
        <option value="">＋ Add chart…</option>
        <option v-for="c in available" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <span v-else class="no-add">All charts added</span>
      <button class="btn btn-ghost danger" @click="deleteDashboard">Delete</button>
    </header>

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
            :chart="analytics.getChart(item.i)!"
            :dataset="analytics.getDataset(analytics.getChart(item.i)!.datasetId)"
            :connection-id="connId"
            :driver="driver"
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
