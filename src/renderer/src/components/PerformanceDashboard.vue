<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { HistoryEntry, TableSizeInfo, PoolStats, SizeSnapshot } from '@shared/types'
import { useTabs } from '../stores/tabs'
import {
  aggregateQueries,
  timeBuckets,
  recommendIndexes,
  fmtMs,
  fmtBytes,
  type QueryStat,
  type IndexRec
} from '../lib/perf'
import BarChart from './BarChart.vue'
import { analyzeIndexes, type AnalyzedTable, type IndexFinding } from '../lib/indexAnalysis'

const props = defineProps<{ connId: string; driver: string }>()
const tabsStore = useTabs()

const isSql = computed(() => ['postgres', 'mysql', 'sqlite', 'mssql'].includes(props.driver))

const loading = ref(false)
const history = ref<HistoryEntry[]>([])
const sizes = ref<TableSizeInfo[]>([])
const pool = ref<PoolStats | null>(null)
const poolSupported = ref(true)
const recs = ref<IndexRec[]>([])
const thresholdMs = ref(100)
const sizeHistory = ref<SizeSnapshot[]>([])

// Index health (lazily scanned — introspects every table, so it's on demand)
const idxScanning = ref(false)
const idxScanned = ref(false)
const idxProgress = ref(0)
const idxTotal = ref(0)
const findings = ref<IndexFinding[]>([])
async function scanIndexes(): Promise<void> {
  if (!isSql.value || idxScanning.value) return
  idxScanning.value = true
  idxProgress.value = 0
  try {
    const tables = (await window.api.db.listTables(props.connId)).filter((t) => t.type === 'table')
    idxTotal.value = tables.length
    const analyzed: AnalyzedTable[] = []
    for (const t of tables) {
      try {
        const st = await window.api.db.tableStructure(props.connId, t)
        analyzed.push({ name: t.name, columns: st.columns, foreignKeys: st.foreignKeys, indexes: st.indexes })
      } catch {
        /* skip */
      }
      idxProgress.value++
    }
    findings.value = analyzeIndexes(analyzed, props.driver)
    idxScanned.value = true
  } finally {
    idxScanning.value = false
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const all = await window.api.history.list()
    history.value = all.filter((h) => h.connectionId === props.connId)
    sizes.value = await window.api.db.tableSizes(props.connId).catch(() => [])
    // Record today's storage measurement and load the growth history.
    const tBytes = sizes.value.reduce((a, s) => a + (s.bytes ?? 0), 0)
    if (tBytes > 0) {
      await window.api.sizeHistory.record(props.connId, tBytes, sizes.value.length).catch(() => {})
    }
    sizeHistory.value = await window.api.sizeHistory.list(props.connId).catch(() => [])
    try {
      pool.value = await window.api.db.poolStats(props.connId)
      poolSupported.value = true
    } catch {
      pool.value = null
      poolSupported.value = false
    }
    await computeRecs()
  } finally {
    loading.value = false
  }
}

const stats = computed<QueryStat[]>(() => aggregateQueries(history.value))
const buckets = computed(() => timeBuckets(history.value, 24))
const slowQueries = computed(() =>
  [...stats.value]
    .filter((s) => s.avgMs >= thresholdMs.value)
    .sort((a, b) => b.avgMs - a.avgMs)
)

// Overview metrics
const totalRuns = computed(() => history.value.length)
const errorRuns = computed(() => history.value.filter((h) => h.error).length)
const avgMs = computed(() => {
  const withMs = history.value.filter((h) => typeof h.durationMs === 'number')
  if (!withMs.length) return 0
  return withMs.reduce((a, h) => a + (h.durationMs ?? 0), 0) / withMs.length
})
const slowestMs = computed(() => Math.max(0, ...history.value.map((h) => h.durationMs ?? 0)))
const totalBytes = computed(() =>
  sizes.value.reduce((a, s) => a + (s.bytes ?? 0), 0)
)

const volumeBars = computed(() =>
  buckets.value.map((b) => ({
    label: b.label,
    value: b.count,
    alert: b.errorCount > 0,
    title: `${b.label} · ${b.count} quer${b.count === 1 ? 'y' : 'ies'} · avg ${fmtMs(b.avgMs)}${b.errorCount ? ` · ${b.errorCount} failed` : ''}`
  }))
)

const topSizes = computed(() => {
  const withBytes = sizes.value.filter((s) => (s.bytes ?? 0) > 0)
  const arr = (withBytes.length ? withBytes : sizes.value).slice()
  arr.sort((a, b) => (b.bytes ?? b.rows ?? 0) - (a.bytes ?? a.rows ?? 0))
  return arr.slice(0, 10)
})
const sizeMax = computed(() => Math.max(1, ...topSizes.value.map((s) => s.bytes ?? s.rows ?? 0)))

const growthBars = computed(() =>
  sizeHistory.value.map((s) => ({
    label: new Date(s.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    value: s.totalBytes,
    title: `${new Date(s.at).toLocaleDateString()} · ${fmtBytes(s.totalBytes)} · ${s.tableCount} tables`
  }))
)
const growthDelta = computed(() => {
  const h = sizeHistory.value
  if (h.length < 2) return null
  const diff = h[h.length - 1].totalBytes - h[0].totalBytes
  const days = Math.max(
    1,
    Math.round((new Date(h[h.length - 1].at).getTime() - new Date(h[0].at).getTime()) / 86_400_000)
  )
  return { diff, days }
})

async function computeRecs(): Promise<void> {
  if (!isSql.value) {
    recs.value = []
    return
  }
  const slow = stats.value.filter((s) => s.kind === 'SELECT' && s.avgMs >= thresholdMs.value)
  // distinct tables mentioned in slow selects (cheap regex)
  const tables = new Set<string>()
  for (const s of slow) {
    const m = s.sample.match(/\bfrom\s+["'`]?([a-z_][\w]*)/i)
    if (m) tables.add(m[1])
  }
  const indexed: Record<string, Set<string>> = {}
  for (const t of [...tables].slice(0, 25)) {
    try {
      const st = await window.api.db.tableStructure(props.connId, { name: t, type: 'table' })
      const set = new Set<string>()
      for (const c of st.columns) if (c.isPrimaryKey) set.add(c.name)
      for (const idx of st.indexes) if (idx.columns[0]) set.add(idx.columns[0])
      indexed[t] = set
    } catch {
      indexed[t] = new Set()
    }
  }
  recs.value = recommendIndexes(stats.value, thresholdMs.value, indexed)
}

watch(() => props.connId, load, { immediate: true })
watch(thresholdMs, () => void computeRecs())

function runSql(sql: string): void {
  tabsStore.openQueryWith(props.connId, sql)
}
function sizePct(s: TableSizeInfo): number {
  return Math.round(((s.bytes ?? s.rows ?? 0) / sizeMax.value) * 100)
}
function poolPct(): number {
  if (!pool.value?.max) return 0
  return Math.min(100, Math.round(((pool.value.active ?? 0) / pool.value.max) * 100))
}
</script>

<template>
  <div class="perf">
    <header class="perf-head">
      <div>
        <h2>Performance</h2>
        <span class="sub">Insights from {{ totalRuns }} recorded quer{{ totalRuns === 1 ? 'y' : 'ies' }} on this connection</span>
      </div>
      <div class="spacer" />
      <label class="thresh">
        Slow ≥
        <select v-model.number="thresholdMs">
          <option :value="20">20 ms</option>
          <option :value="50">50 ms</option>
          <option :value="100">100 ms</option>
          <option :value="250">250 ms</option>
          <option :value="500">500 ms</option>
          <option :value="1000">1 s</option>
        </select>
      </label>
      <button class="btn btn-ghost" :disabled="loading" @click="load">⟳ Refresh</button>
    </header>

    <div v-if="!totalRuns && !loading" class="empty">
      <div class="logo">📊</div>
      <h3>No query activity yet</h3>
      <p>Run some queries on this connection and the dashboard will fill with timings, slow-query analysis and index suggestions.</p>
    </div>

    <div v-else class="body">
      <!-- overview cards -->
      <section class="cards">
        <div class="card">
          <span class="k">Queries</span>
          <span class="v">{{ totalRuns }}</span>
        </div>
        <div class="card">
          <span class="k">Avg duration</span>
          <span class="v">{{ fmtMs(avgMs) }}</span>
        </div>
        <div class="card">
          <span class="k">Slowest</span>
          <span class="v">{{ fmtMs(slowestMs) }}</span>
        </div>
        <div class="card" :class="{ bad: errorRuns > 0 }">
          <span class="k">Errors</span>
          <span class="v">{{ errorRuns }}<small v-if="totalRuns"> · {{ Math.round((errorRuns / totalRuns) * 100) }}%</small></span>
        </div>
        <div class="card">
          <span class="k">Storage</span>
          <span class="v">{{ totalBytes ? fmtBytes(totalBytes) : '—' }}</span>
        </div>
      </section>

      <!-- query volume over time -->
      <section class="panel">
        <h3>Query volume over time</h3>
        <BarChart v-if="volumeBars.length" :bars="volumeBars" :height="150" />
        <p v-else class="muted">Not enough data.</p>
      </section>

      <!-- storage growth over time -->
      <section class="panel">
        <h3>
          Storage growth
          <span v-if="growthDelta" class="grow-delta" :class="{ up: growthDelta.diff > 0, down: growthDelta.diff < 0 }">
            {{ growthDelta.diff >= 0 ? '+' : '−' }}{{ fmtBytes(Math.abs(growthDelta.diff)) }} over {{ growthDelta.days }} day{{ growthDelta.days === 1 ? '' : 's' }}
          </span>
        </h3>
        <BarChart v-if="growthBars.length >= 2" :bars="growthBars" :height="140" />
        <p v-else class="muted">
          Tracking started — a measurement is saved each day you open this dashboard, and the growth trend appears here as snapshots accrue.
        </p>
      </section>

      <div class="two-col">
        <!-- slow queries -->
        <section class="panel">
          <h3>Slow queries <span class="count">{{ slowQueries.length }}</span></h3>
          <div v-if="slowQueries.length" class="qlist">
            <div v-for="(q, i) in slowQueries.slice(0, 8)" :key="i" class="qrow">
              <div class="qtop">
                <span class="kind" :class="q.kind.toLowerCase()">{{ q.kind }}</span>
                <span class="qavg">{{ fmtMs(q.avgMs) }} avg</span>
                <span class="qmeta">×{{ q.count }} · max {{ fmtMs(q.maxMs) }}</span>
              </div>
              <code class="qsql" :title="q.sample">{{ q.sample }}</code>
            </div>
          </div>
          <p v-else class="muted">No queries slower than {{ fmtMs(thresholdMs) }}. 🎉</p>
        </section>

        <!-- index recommendations -->
        <section class="panel">
          <h3>Index recommendations <span class="count">{{ recs.length }}</span></h3>
          <p v-if="!isSql" class="muted">Not available for {{ driver }}.</p>
          <div v-else-if="recs.length" class="recs">
            <div v-for="(r, i) in recs.slice(0, 8)" :key="i" class="rec">
              <div class="rec-info">
                <strong>{{ r.table }}</strong> · <span class="cols">{{ r.columns.join(', ') }}</span>
                <span class="rec-why">{{ r.reason }} (~{{ fmtMs(r.avgMs) }})</span>
              </div>
              <button class="btn btn-ghost sm" title="Open as a query" @click="runSql(r.ddl)">Create →</button>
            </div>
          </div>
          <p v-else class="muted">No suggestions — slow queries look adequately indexed. 👍</p>
        </section>
      </div>

      <div class="two-col">
        <!-- storage breakdown -->
        <section class="panel">
          <h3>Storage by table</h3>
          <div v-if="topSizes.length" class="bars">
            <div v-for="s in topSizes" :key="s.name" class="hbar">
              <span class="hbar-label" :title="s.name">{{ s.name }}</span>
              <div class="hbar-track">
                <div class="hbar-fill" :style="{ width: sizePct(s) + '%' }" />
              </div>
              <span class="hbar-val">{{ s.bytes != null ? fmtBytes(s.bytes) : (s.rows ?? 0) + ' rows' }}</span>
            </div>
          </div>
          <p v-else class="muted">Size information isn't available for this connection.</p>
        </section>

        <!-- connection pool -->
        <section class="panel">
          <h3>Connection pool</h3>
          <template v-if="poolSupported && pool">
            <div class="pool-gauge">
              <div class="pool-track">
                <div class="pool-fill" :style="{ width: poolPct() + '%' }" />
              </div>
              <span class="pool-pct">{{ poolPct() }}% used</span>
            </div>
            <div class="pool-stats">
              <div><span class="k">In use</span><span class="v">{{ pool.active ?? 0 }}</span></div>
              <div><span class="k">Idle</span><span class="v">{{ pool.idle ?? 0 }}</span></div>
              <div><span class="k">Total</span><span class="v">{{ pool.total ?? 0 }}</span></div>
              <div><span class="k">Max</span><span class="v">{{ pool.max ?? '—' }}</span></div>
              <div :class="{ bad: (pool.waiting ?? 0) > 0 }"><span class="k">Waiting</span><span class="v">{{ pool.waiting ?? 0 }}</span></div>
            </div>
          </template>
          <p v-else class="muted">Pool diagnostics aren't available for {{ driver }}.</p>
        </section>
      </div>

      <!-- index health (structural analysis, scanned on demand) -->
      <section class="panel">
        <h3>
          Index health
          <span v-if="idxScanned" class="count">{{ findings.length }}</span>
          <div class="spacer" />
          <button v-if="isSql" class="btn btn-ghost sm" :disabled="idxScanning" @click="scanIndexes">
            {{ idxScanning ? `Scanning… ${idxProgress}/${idxTotal}` : idxScanned ? '⟳ Rescan' : '⌕ Scan schema' }}
          </button>
        </h3>
        <p v-if="!isSql" class="muted">Not available for {{ driver }}.</p>
        <p v-else-if="!idxScanned && !idxScanning" class="muted">
          Scan the schema for redundant indexes, foreign keys missing an index, and tables without a primary key.
        </p>
        <p v-else-if="idxScanned && !findings.length" class="muted">No index issues found. 👍</p>
        <div v-else-if="findings.length" class="findings">
          <div v-for="(f, i) in findings" :key="i" class="finding" :class="f.kind">
            <span class="fdot" :class="f.severity" />
            <div class="finfo">
              <strong>{{ f.table }}</strong> — {{ f.title }}
              <span class="fdetail">{{ f.detail }}</span>
            </div>
            <button v-if="f.ddl" class="btn btn-ghost sm" title="Open the fix as a query" @click="runSql(f.ddl)">
              {{ f.kind === 'redundant' ? 'Drop →' : 'Create →' }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.perf {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  background: var(--bg-app);
}
.perf-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg-app);
  z-index: 2;
}
.perf-head h2 {
  font-size: 16px;
}
.sub {
  font-size: 12px;
  color: var(--text-faint);
}
.spacer {
  flex: 1;
}
.thresh {
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 6px;
}
.thresh select {
  font-size: 12px;
  padding: 3px 6px;
}
.empty {
  margin: auto;
  text-align: center;
  color: var(--text-dim);
  max-width: 420px;
  padding: 60px 20px;
}
.empty .logo {
  font-size: 36px;
}
.empty h3 {
  color: var(--text);
  margin: 10px 0 6px;
}
.body {
  padding: 18px 20px 40px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 12px;
}
.card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.card.bad {
  border-color: var(--danger);
}
.card .k {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
}
.card .v {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
}
.card .v small {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-dim);
}
.panel {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
}
.panel h3 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel h3 .count {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 7px;
  font-size: 10px;
  color: var(--text-dim);
}
.grow-delta {
  font-size: 11px;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text-dim);
}
.grow-delta.up {
  color: var(--warn);
}
.grow-delta.down {
  color: var(--ok);
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.muted {
  font-size: 12.5px;
  color: var(--text-faint);
}
.qlist {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.qrow {
  border-left: 2px solid var(--border-strong);
  padding-left: 10px;
}
.qtop {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
}
.kind {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent);
}
.kind.update,
.kind.delete,
.kind.insert {
  background: rgba(240, 180, 41, 0.18);
  color: var(--warn);
}
.qavg {
  font-weight: 700;
  font-size: 13px;
  color: var(--text);
}
.qmeta {
  font-size: 11px;
  color: var(--text-faint);
}
.qsql {
  display: block;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.recs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rec {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.rec-info {
  flex: 1;
  font-size: 12.5px;
  min-width: 0;
}
.rec-info .cols {
  font-family: var(--mono);
  color: var(--accent);
}
.rec-why {
  display: block;
  font-size: 11px;
  color: var(--text-faint);
}
.btn.sm {
  padding: 4px 9px;
  font-size: 11.5px;
  flex: none;
}
.panel h3 .btn {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
}
.findings {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.finding {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.fdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.fdot.warn {
  background: var(--warn);
}
.fdot.info {
  background: var(--text-faint);
}
.finfo {
  flex: 1;
  font-size: 12.5px;
  min-width: 0;
}
.fdetail {
  display: block;
  font-size: 11.5px;
  color: var(--text-faint);
}
.bars {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hbar {
  display: grid;
  grid-template-columns: 120px 1fr 70px;
  align-items: center;
  gap: 10px;
}
.hbar-label {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hbar-track {
  background: var(--bg-elevated);
  border-radius: 4px;
  height: 12px;
  overflow: hidden;
}
.hbar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
}
.hbar-val {
  font-size: 11px;
  color: var(--text-dim);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pool-gauge {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.pool-track {
  flex: 1;
  height: 12px;
  background: var(--bg-elevated);
  border-radius: 6px;
  overflow: hidden;
}
.pool-fill {
  height: 100%;
  background: var(--accent);
}
.pool-pct {
  font-size: 11px;
  color: var(--text-dim);
}
.pool-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
  gap: 10px;
}
.pool-stats > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pool-stats .k {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-faint);
}
.pool-stats .v {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}
.pool-stats .bad .v {
  color: var(--danger);
}
@media (max-width: 900px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
</style>
