<script setup lang="ts">
import Icon from './Icon.vue'
import { useUi } from '../stores/ui'
import { ref, computed, onMounted, onUnmounted } from 'vue'
import BarChart from './BarChart.vue'
import type {
  QueueFramework,
  QueueJob,
  QueueJobState,
  QueueOverview,
  RedisServerStats
} from '@shared/types'

const ui = useUi()

const props = defineProps<{ connId: string }>()

const POLL_MS = 2000
const HISTORY = 60

const server = ref<RedisServerStats | null>(null)
const queues = ref<QueueOverview[]>([])
const error = ref('')
const firstLoad = ref(true)
const paused = ref(false)

// Rolling history for the live sparklines.
const opsHistory = ref<number[]>([])
const pendingHistory = ref<number[]>([])

// Drill-down state.
const open = ref<{ queue: string; state: QueueJobState } | null>(null)
const jobs = ref<QueueJob[]>([])
const jobsBusy = ref(false)
const expanded = ref<number | null>(null)

let timer: ReturnType<typeof setInterval> | undefined

const FRAMEWORK_LABEL: Record<QueueFramework, string> = {
  laravel: 'Laravel',
  horizon: 'Horizon',
  bullmq: 'BullMQ',
  bull: 'Bull',
  rq: 'RQ',
  celery: 'Celery',
  sidekiq: 'Sidekiq',
  generic: 'Generic'
}

const STATE_LABEL: Record<QueueJobState, string> = {
  pending: 'Pending',
  reserved: 'Active',
  delayed: 'Delayed',
  failed: 'Failed',
  completed: 'Completed'
}

async function poll(): Promise<void> {
  if (paused.value) return
  try {
    const [s, q] = await Promise.all([
      window.api.redis.serverStats(props.connId),
      window.api.redis.queues(props.connId)
    ])
    server.value = s
    queues.value = q
    error.value = ''
    opsHistory.value = [...opsHistory.value, s.opsPerSec].slice(-HISTORY)
    const totalPending = q.reduce((n, x) => n + x.pending, 0)
    pendingHistory.value = [...pendingHistory.value, totalPending].slice(-HISTORY)
    // Refresh the open drill-down too.
    if (open.value) await loadJobs(open.value.queue, open.value.state, false)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    firstLoad.value = false
  }
}

async function loadJobs(queue: string, state: QueueJobState, toggle = true): Promise<void> {
  if (toggle && open.value?.queue === queue && open.value?.state === state) {
    open.value = null
    jobs.value = []
    return
  }
  open.value = { queue, state }
  if (toggle) jobsBusy.value = true
  try {
    jobs.value = await window.api.redis.queueJobs(props.connId, queue, state, 0, 50)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    jobsBusy.value = false
  }
}

async function removeJob(job: QueueJob): Promise<void> {
  if (!open.value) return
  const ok = await ui.confirmDialog({
    title: 'Remove job',
    message: `Remove this job from "${open.value.queue}" (${open.value.state})?`,
    confirmLabel: 'Remove job',
    danger: true
  })
  if (!ok || !open.value) return
  await window.api.redis.queueAction(props.connId, 'delete', open.value.queue, open.value.state, job.member)
  await loadJobs(open.value.queue, open.value.state, false)
  await poll()
}

async function purge(queue: string, state: QueueJobState): Promise<void> {
  const ok = await ui.confirmDialog({
    title: 'Purge jobs',
    message: `Purge all ${STATE_LABEL[state].toLowerCase()} jobs from "${queue}"? This cannot be undone.`,
    confirmLabel: 'Purge jobs',
    danger: true
  })
  if (!ok) return
  await window.api.redis.queueAction(props.connId, 'purge', queue, state)
  await poll()
  if (open.value?.queue === queue && open.value?.state === state) await loadJobs(queue, state, false)
}

onMounted(() => {
  void poll()
  timer = setInterval(() => void poll(), POLL_MS)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

// ---- derived display --------------------------------------------------------

function bytes(b: number): string {
  if (!b) return '0 B'
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}
function uptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}
const hitRate = computed(() => {
  const s = server.value
  if (!s) return '—'
  const total = s.keyspaceHits + s.keyspaceMisses
  return total ? `${((s.keyspaceHits / total) * 100).toFixed(1)}%` : '—'
})
const opsBars = computed(() => opsHistory.value.map((v) => ({ label: '', value: v })))
const pendingBars = computed(() => pendingHistory.value.map((v) => ({ label: '', value: v })))

function stateCells(q: QueueOverview): { state: QueueJobState; label: string; n: number }[] {
  const out: { state: QueueJobState; label: string; n: number }[] = [
    { state: 'pending', label: STATE_LABEL.pending, n: q.pending },
    { state: 'reserved', label: STATE_LABEL.reserved, n: q.reserved },
    { state: 'delayed', label: STATE_LABEL.delayed, n: q.delayed },
    { state: 'failed', label: STATE_LABEL.failed, n: q.failed }
  ]
  if (q.completed != null) out.push({ state: 'completed', label: STATE_LABEL.completed, n: q.completed })
  return out
}
</script>

<template>
  <div class="rq">
    <header class="rq-head">
      <div class="title">
        <h2>Redis Queues</h2>
        <span class="live" :class="{ off: paused }">{{ paused ? 'paused' : 'live' }}</span>
      </div>
      <div class="head-actions">
        <button class="btn" @click="paused = !paused"><Icon :name="paused ? 'play' : 'pause'" :size="13" /> {{ paused ? 'Resume' : 'Pause' }}</button>
        <button class="btn" @click="poll()"><Icon name="refresh" :size="13" /> Refresh</button>
      </div>
    </header>

    <div v-if="error" class="err" role="alert">{{ error }}</div>
    <div v-if="firstLoad" class="muted">Connecting…</div>

    <template v-else>
      <!-- server stats -->
      <section v-if="server" class="stats">
        <div class="stat"><span class="lbl">Memory</span><span class="num">{{ bytes(server.usedMemoryBytes) }}</span></div>
        <div class="stat"><span class="lbl">Clients</span><span class="num">{{ server.connectedClients }}</span></div>
        <div class="stat"><span class="lbl">Ops/sec</span><span class="num">{{ server.opsPerSec }}</span></div>
        <div class="stat"><span class="lbl">Hit rate</span><span class="num">{{ hitRate }}</span></div>
        <div class="stat"><span class="lbl">Keys</span><span class="num">{{ server.totalKeys }}</span></div>
        <div class="stat"><span class="lbl">Uptime</span><span class="num">{{ uptime(server.uptimeSec) }}</span></div>
        <div class="stat ver"><span class="lbl">Redis</span><span class="num">{{ server.version }}</span></div>
      </section>

      <!-- live charts -->
      <section class="charts">
        <div class="chart-card">
          <div class="chart-title">Throughput · ops/sec</div>
          <BarChart :bars="opsBars" :height="90" :max-ticks="1" />
        </div>
        <div class="chart-card">
          <div class="chart-title">Pending jobs (all queues)</div>
          <BarChart :bars="pendingBars" :height="90" :max-ticks="1" />
        </div>
      </section>

      <!-- queues -->
      <section v-if="queues.length" class="queues">
        <div v-for="q in queues" :key="q.framework + ':' + q.name" class="qcard">
          <div class="qhead">
            <span class="qname">{{ q.name }}</span>
            <span class="badge" :class="q.framework">{{ FRAMEWORK_LABEL[q.framework] }}</span>
          </div>
          <div class="cells">
            <button
              v-for="c in stateCells(q)"
              :key="c.state"
              class="cell"
              :class="[c.state, { active: open?.queue === q.name && open?.state === c.state, zero: c.n === 0 }]"
              :disabled="c.n === 0"
              @click="loadJobs(q.name, c.state)"
            >
              <span class="cn">{{ c.n }}</span>
              <span class="cl">{{ c.label }}</span>
            </button>
          </div>

          <!-- drill-down -->
          <div v-if="open?.queue === q.name" class="jobs">
            <div class="jobs-head">
              <span>{{ STATE_LABEL[open.state] }} · {{ jobs.length }} shown</span>
              <button class="btn-link danger" @click="purge(q.name, open.state)">Purge {{ STATE_LABEL[open.state].toLowerCase() }}</button>
            </div>
            <div v-if="jobsBusy" class="muted sm">Loading jobs…</div>
            <div v-else-if="!jobs.length" class="muted sm">No jobs.</div>
            <ul v-else class="job-list">
              <li v-for="(j, i) in jobs" :key="i" class="job">
                <div class="job-row" @click="expanded = expanded === i ? null : i">
                  <button class="caret" title="Toggle payload" :aria-expanded="expanded === i" @click.stop="expanded = expanded === i ? null : i"><Icon :name="expanded === i ? 'chevronDown' : 'chevronRight'" :size="11" /></button>
                  <span class="job-name">{{ j.name || '(unnamed job)' }}</span>
                  <span v-if="j.attempts != null" class="job-attempts">×{{ j.attempts }}</span>
                  <span v-if="j.exception" class="job-exc">{{ j.exception }}</span>
                  <span class="spacer" />
                  <button class="btn-link danger" @click.stop="removeJob(j)">Remove</button>
                </div>
                <pre v-if="expanded === i" class="job-payload">{{ JSON.stringify(j.payload, null, 2) }}</pre>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <div v-else class="empty">
        <p>No queues detected.</p>
        <p class="muted sm">
          DataDock auto-detects Laravel/Horizon, BullMQ, Sidekiq, RQ and Celery queues, plus any
          list/sorted-set keys that look like a queue. Make sure jobs have been enqueued on this database.
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.rq {
  height: 100%;
  overflow-y: auto;
  padding: 18px 20px;
}
.rq-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.title h2 {
  font-size: var(--fs-md);
  font-weight: 600;
}
.live {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ok-text);
  border: 1px solid var(--ok);
  border-radius: 10px;
  padding: 1px 8px;
}
.live::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 5px;
  animation: pulse 1.4s ease-in-out infinite;
}
.live.off {
  color: var(--text-faint);
  border-color: var(--border);
}
.live.off::before {
  animation: none;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
.head-actions {
  display: flex;
  gap: 8px;
}
.err {
  background: var(--danger-soft);
  color: var(--danger-text);
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  margin-bottom: 12px;
}
.muted {
  color: var(--text-faint);
  font-size: var(--fs-base);
}
.muted.sm {
  font-size: var(--fs-sm);
  line-height: 1.5;
}

/* server stats */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.stat {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 9px 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.stat .lbl {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}
.stat .num {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
}
.stat.ver .num {
  font-size: var(--fs-base);
}

/* charts */
.charts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 18px;
}
.chart-card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.chart-title {
  font-size: var(--fs-xs);
  color: var(--text-faint);
  margin-bottom: 6px;
}

/* queues */
.queues {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.qcard {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
}
.qhead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.qname {
  font-family: var(--mono);
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text);
}
.badge {
  font-size: var(--fs-xs);
  padding: 1px 7px;
  border-radius: 9px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  border: 1px solid var(--border);
}
.badge.laravel, .badge.horizon { color: var(--hue-orange); border-color: currentColor; }
.badge.bullmq, .badge.bull { color: var(--hue-blue); border-color: var(--hue-blue); }
.badge.sidekiq { color: var(--danger-text); border-color: currentColor; }
.badge.rq, .badge.celery { color: var(--ok-text); border-color: currentColor; }

.cells {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.cell {
  flex: 1;
  min-width: 78px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: border-color 0.1s ease, background 0.1s ease;
}
.cell:not(.zero):hover {
  border-color: var(--accent);
}
.cell.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.cell.zero {
  opacity: 0.5;
  cursor: default;
}
.cell .cn {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text);
}
.cell .cl {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}
.cell.failed .cn { color: var(--danger-text); }
.cell.reserved .cn { color: var(--accent-text); }

/* jobs drill-down */
.jobs {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.jobs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-xs);
  color: var(--text-faint);
  margin-bottom: 6px;
}
.job-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.job {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.job-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  cursor: pointer;
  font-size: var(--fs-sm);
}
.job-row:hover {
  background: var(--bg-elevated);
}
.caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--text-faint);
}
.job-name {
  font-family: var(--mono);
  color: var(--text);
}
.job-attempts {
  font-size: var(--fs-xs);
  color: var(--text-faint);
}
.job-exc {
  font-size: var(--fs-xs);
  color: var(--danger-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}
.spacer {
  flex: 1;
}
.job-payload {
  margin: 0;
  padding: 10px 12px;
  background: var(--bg-elevated);
  border-top: 1px solid var(--border);
  font-family: var(--mono);
  font-size: var(--fs-xs);
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}
.btn-link {
  background: none;
  border: none;
  color: var(--accent-text);
  font-size: var(--fs-xs);
  cursor: pointer;
  padding: 0;
}
.btn-link.danger {
  color: var(--danger-text);
}
.empty {
  text-align: center;
  padding: 40px 20px;
}
.empty p {
  margin: 0 auto 6px;
  max-width: 460px;
}
</style>
