<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import type { IndexDef } from '@shared/types'
import { useTabs } from '../stores/tabs'
import { buildEnvDiff, type EnvTableDiff } from '../lib/envDiff'

const props = defineProps<{
  connId: string
  connName: string
  candidates: { id: string; label: string }[]
}>()
const tabsStore = useTabs()

const targetId = ref('')
const targetLabel = ref('')
const busy = ref(false)
const progress = ref(0)
const progressTotal = ref(0)
const error = ref('')
const report = ref<EnvTableDiff[] | null>(null)
const onlyDiffs = ref(true)
const expanded = reactive<Set<string>>(new Set())

// Optional checks. Data is off by default — production data normally differs,
// so you opt specific (reference/config) tables in.
const checkColumns = ref(true)
const checkIndexes = ref(true)
const checkData = ref(false)
const dataTables = reactive<Set<string>>(new Set())

function effectiveDiffers(t: EnvTableDiff): boolean {
  return (
    t.tableStatus !== 'common' ||
    (checkColumns.value && t.hasColumnDiff) ||
    (checkIndexes.value && t.hasIndexDiff) ||
    (checkData.value && dataTables.has(t.name) && t.rowsDiffer)
  )
}
const visible = computed(() =>
  (report.value ?? []).filter((t) => (onlyDiffs.value ? effectiveDiffers(t) : true))
)
const counts = computed(() => {
  const c = { onlyA: 0, onlyB: 0, columns: 0, indexes: 0, data: 0 }
  for (const t of report.value ?? []) {
    if (t.tableStatus === 'onlyA') c.onlyA++
    else if (t.tableStatus === 'onlyB') c.onlyB++
    if (checkColumns.value && t.hasColumnDiff) c.columns++
    if (checkIndexes.value && t.hasIndexDiff) c.indexes++
    if (checkData.value && dataTables.has(t.name) && t.rowsDiffer) c.data++
  }
  return c
})

async function run(): Promise<void> {
  if (!targetId.value) return
  busy.value = true
  error.value = ''
  report.value = null
  progress.value = 0
  dataTables.clear()
  try {
    await window.api.db.connect(targetId.value)
    const [snapA, snapB] = await Promise.all([
      window.api.db.schemaSnapshot(props.connId),
      window.api.db.schemaSnapshot(targetId.value)
    ])
    const [sizesA, sizesB] = await Promise.all([
      window.api.db.tableSizes(props.connId).catch(() => []),
      window.api.db.tableSizes(targetId.value).catch(() => [])
    ])
    const common = snapA.map((t) => t.name).filter((n) => snapB.some((t) => t.name === n))

    const indexesA: Record<string, IndexDef[]> = {}
    const indexesB: Record<string, IndexDef[]> = {}
    if (checkIndexes.value) {
      progressTotal.value = common.length
      for (const name of common) {
        const info = { name, type: 'table' as const }
        const [a, b] = await Promise.all([
          window.api.db.tableStructure(props.connId, info).then((s) => s.indexes).catch(() => []),
          window.api.db.tableStructure(targetId.value, info).then((s) => s.indexes).catch(() => [])
        ])
        indexesA[name] = a
        indexesB[name] = b
        progress.value++
      }
    }
    report.value = buildEnvDiff(snapA, snapB, sizesA, sizesB, indexesA, indexesB)
    targetLabel.value = props.candidates.find((c) => c.id === targetId.value)?.label ?? 'target'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function toggleExpand(name: string): void {
  expanded.has(name) ? expanded.delete(name) : expanded.add(name)
}
function toggleData(name: string): void {
  dataTables.has(name) ? dataTables.delete(name) : dataTables.add(name)
}
const statusBadge = (s: EnvTableDiff['tableStatus']): string =>
  ({ onlyA: `only in ${props.connName}`, onlyB: 'only in target', common: '' })[s]
</script>

<template>
  <div class="env">
    <div class="toolbar">
      <strong>Environment Diff</strong>
      <span class="muted">{{ connName }}</span>
      <span class="arrow">↔</span>
      <select class="select" v-model="targetId" :disabled="busy">
        <option value="" disabled>Compare with…</option>
        <option v-for="c in candidates" :key="c.id" :value="c.id">{{ c.label }}</option>
      </select>
      <button class="btn btn-primary" :disabled="!targetId || busy" @click="run">
        {{ busy ? (progressTotal ? `Comparing ${progress}/${progressTotal}…` : 'Comparing…') : 'Compare' }}
      </button>
      <div class="spacer" />
      <label v-if="report" class="chk"><input type="checkbox" v-model="onlyDiffs" /> Only differences</label>
    </div>

    <div class="checks">
      <span class="ctitle">Check:</span>
      <label class="chk"><input type="checkbox" v-model="checkColumns" /> Tables & columns</label>
      <label class="chk"><input type="checkbox" v-model="checkIndexes" /> Indexes</label>
      <label class="chk"><input type="checkbox" v-model="checkData" /> Data (row counts)</label>
      <span v-if="checkData" class="hint">— tick specific tables below; production data normally differs everywhere.</span>
    </div>

    <div v-if="error" class="err">{{ error }}</div>
    <div v-if="!report && !busy && !error" class="empty">
      Pick a connection (e.g. Staging) to compare against “{{ connName }}”.
    </div>

    <div v-if="report" class="summary">
      <span class="s onlyA">{{ counts.onlyA }} only here</span>
      <span class="s onlyB">{{ counts.onlyB }} only in target</span>
      <span v-if="checkColumns" class="s changed">{{ counts.columns }} column diffs</span>
      <span v-if="checkIndexes" class="s idx">{{ counts.indexes }} index diffs</span>
      <span v-if="checkData" class="s data">{{ counts.data }} data diffs</span>
    </div>

    <div v-if="report" class="list">
      <div v-for="t in visible" :key="t.name" class="trow">
        <div class="thead" :class="t.tableStatus" @click="toggleExpand(t.name)">
          <span class="caret">{{ expanded.has(t.name) ? '▾' : '▸' }}</span>
          <span class="tname">{{ t.name }}</span>
          <span v-if="t.tableStatus !== 'common'" class="tbadge" :class="t.tableStatus">{{ statusBadge(t.tableStatus) }}</span>
          <template v-else>
            <span v-if="checkColumns && t.hasColumnDiff" class="chip col">📋 {{ t.columnDiffs.length }}</span>
            <span v-if="checkIndexes && t.hasIndexDiff" class="chip idx">🔑 {{ t.indexDiffs.length }}</span>
            <label
              v-if="checkData"
              class="dchk"
              :class="{ on: dataTables.has(t.name) }"
              @click.stop
            >
              <input type="checkbox" :checked="dataTables.has(t.name)" @change="toggleData(t.name)" /> data
            </label>
            <span v-if="checkData && dataTables.has(t.name)" class="chip data" :class="{ differ: t.rowsDiffer }">
              📊 {{ t.rowsA ?? '—' }} → {{ t.rowsB ?? '—' }}
            </span>
          </template>
        </div>
        <div v-if="expanded.has(t.name)" class="detail">
          <template v-if="checkColumns && t.columnDiffs.length">
            <div class="dgrp">Columns</div>
            <div v-for="c in t.columnDiffs" :key="'c' + c.name" class="drow" :class="c.status">
              <span class="dmark">{{ c.status === 'added' ? '+' : c.status === 'removed' ? '−' : '~' }}</span>
              <span class="dname">{{ c.name }}</span>
              <span class="ddetail">
                <template v-if="c.status === 'changed'">{{ c.detail }}</template>
                <template v-else-if="c.status === 'added'">{{ c.b?.type }} (in target)</template>
                <template v-else>{{ c.a?.type }} (in {{ connName }})</template>
              </span>
            </div>
          </template>
          <template v-if="checkIndexes && t.indexDiffs.length">
            <div class="dgrp">Indexes</div>
            <div v-for="ix in t.indexDiffs" :key="'i' + ix.name" class="drow" :class="ix.status">
              <span class="dmark">{{ ix.status === 'added' ? '+' : ix.status === 'removed' ? '−' : '~' }}</span>
              <span class="dname">{{ ix.name }}</span>
              <span class="ddetail">
                <template v-if="ix.status === 'changed'">{{ ix.detail }}</template>
                <template v-else-if="ix.status === 'added'">({{ ix.b?.columns.join(', ') }}) in target</template>
                <template v-else>({{ ix.a?.columns.join(', ') }}) in {{ connName }}</template>
              </span>
            </div>
          </template>
          <div v-if="checkData && dataTables.has(t.name)" class="dgrp">
            Data — {{ t.rowsA ?? '—' }} rows here vs {{ t.rowsB ?? '—' }} in target
            <button class="link" @click="tabsStore.openDataDiff(connId)">open full data diff →</button>
          </div>
        </div>
      </div>
      <div v-if="visible.length === 0" class="empty">No differences for the selected checks. 🎉</div>
    </div>
  </div>
</template>

<style scoped>
.env {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.muted {
  color: var(--text-dim);
  font-size: 12px;
}
.arrow {
  color: var(--text-faint);
}
.spacer {
  flex: 1;
}
.checks {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  font-size: 12px;
  flex-wrap: wrap;
}
.ctitle {
  color: var(--text-faint);
  font-weight: 600;
}
.chk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim);
}
.hint {
  color: var(--text-faint);
  font-style: italic;
}
.err {
  padding: 10px 14px;
  color: var(--danger);
  font-size: 12px;
}
.empty {
  padding: 30px 20px;
  text-align: center;
  color: var(--text-faint);
  font-size: 13px;
}
.summary {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  flex-wrap: wrap;
}
.s {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.s.onlyA,
.s.onlyB {
  color: var(--warn);
}
.s.changed {
  color: var(--accent);
}
.s.idx {
  color: #b07ad6;
}
.s.data {
  color: #e0915a;
}
.list {
  flex: 1;
  overflow-y: auto;
  padding: 0 14px 30px;
}
.trow {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 6px;
  overflow: hidden;
}
.thead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  background: var(--bg-panel);
}
.thead:hover {
  background: var(--bg-hover);
}
.caret {
  color: var(--text-faint);
}
.tname {
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 600;
}
.tbadge {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(240, 180, 41, 0.15);
  color: var(--warn);
}
.chip {
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.chip.col {
  color: var(--accent);
}
.chip.idx {
  color: #b07ad6;
}
.chip.data.differ {
  color: var(--danger);
  border-color: var(--danger);
}
.dchk {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-faint);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dchk.on {
  color: var(--text-dim);
}
.detail {
  border-top: 1px solid var(--border);
  padding: 8px 12px;
  background: var(--bg-app);
}
.dgrp {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
  margin: 6px 0 4px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.drow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
}
.dmark {
  width: 12px;
  text-align: center;
  font-weight: 700;
}
.drow.added .dmark {
  color: var(--ok);
}
.drow.removed .dmark {
  color: var(--danger);
}
.drow.changed .dmark {
  color: var(--warn);
}
.dname {
  font-family: var(--mono);
}
.ddetail {
  color: var(--text-faint);
  font-size: 11.5px;
}
.link {
  color: var(--accent);
  font-size: 11px;
}
</style>
