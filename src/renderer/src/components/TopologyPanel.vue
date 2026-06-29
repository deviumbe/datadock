<script setup lang="ts">
import { computed, reactive, ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { useWorkspace } from '../stores/workspace'
import { useUi } from '../stores/ui'
import type { ReplicationStatus, Topology, TopologyNode } from '@shared/types'

const props = defineProps<{ topologyId: string }>()
const emit = defineEmits<{ edit: [topology: Topology] }>()

const ws = useWorkspace()
const ui = useUi()

const topology = computed<Topology | undefined>(() => ws.topologies.find((t) => t.id === props.topologyId))
const warn = computed(() => topology.value?.lagWarnSeconds ?? 1)
const crit = computed(() => topology.value?.lagCritSeconds ?? 10)

type Phase = 'idle' | 'loading' | 'ok' | 'offline' | 'down'
interface NodeState {
  phase: Phase
  status?: ReplicationStatus
  err?: string
  at?: number
}
const states = reactive<Record<string, NodeState>>({})

const primaries = computed(() => topology.value?.nodes.filter((n) => n.role === 'primary') ?? [])
const others = computed(() => topology.value?.nodes.filter((n) => n.role !== 'primary') ?? [])

function connName(id: string): string {
  return ws.findConnection(id)?.name ?? '(deleted)'
}
function connDriver(id: string): string {
  return ws.findConnection(id)?.driver ?? '?'
}

// ---- colour / health ----
type Color = 'green' | 'amber' | 'red' | 'grey'
function lagColor(lag: number | null | undefined): Color {
  if (lag == null) return 'grey'
  if (lag >= crit.value) return 'red'
  if (lag >= warn.value) return 'amber'
  return 'green'
}
interface NodeView {
  color: Color
  badge: string
  lag?: number | null
  detail: string[]
  detected?: string
  error?: string
  position?: string
}
function nodeView(node: TopologyNode): NodeView {
  const st = states[node.connectionId]
  if (!st || (st.phase === 'loading' && !st.status)) return { color: 'grey', badge: 'Checking…', detail: [] }
  if (st.phase === 'offline') return { color: 'grey', badge: 'Not connected', detail: [] }
  if (st.phase === 'down') return { color: 'red', badge: 'Unreachable', detail: st.err ? [st.err] : [] }
  const s = st.status
  if (!s) return { color: 'grey', badge: '—', detail: [] }
  if (s.error) return { color: 'grey', badge: 'No status', detail: [s.error], detected: s.detectedRole, position: s.position }
  if (s.isPrimary) {
    return {
      color: 'green',
      badge: 'Primary',
      detail: [
        `${s.replicas?.length ?? 0} streaming replica(s)`,
        ...(s.detail ?? [])
      ],
      detected: s.detectedRole,
      position: s.position
    }
  }
  const c = lagColor(s.lagSeconds)
  return {
    color: c,
    badge: c === 'green' ? 'In sync' : c === 'grey' ? 'Lag unknown' : 'Lagging',
    lag: s.lagSeconds,
    detail: s.detail ?? [],
    detected: s.detectedRole,
    position: s.position
  }
}

function fmtLag(lag: number | null | undefined): string {
  if (lag == null) return '—'
  if (lag < 1) return `${Math.round(lag * 1000)}ms`
  if (lag < 10) return `${lag.toFixed(1)}s`
  if (lag < 90) return `${Math.round(lag)}s`
  return `${Math.round(lag / 60)}m`
}

// ---- lag history (in-memory rolling window → the per-node sparkline) ----
const HISTORY_CAP = 60
const history = reactive<Record<string, number[]>>({})
function pushHistory(id: string, lag: number): void {
  const arr = history[id] ?? (history[id] = [])
  arr.push(lag)
  if (arr.length > HISTORY_CAP) arr.shift()
}
function hasSpark(id: string): boolean {
  return (history[id]?.length ?? 0) >= 2
}
/** SVG polyline `points` for a node's lag trend, scaled to w×h (red threshold kept in frame). */
function sparkPoints(id: string, w: number, h: number): string {
  const arr = history[id]
  if (!arr || arr.length < 2) return ''
  const max = Math.max(...arr, crit.value)
  const span = max || 1
  const step = w / (arr.length - 1)
  return arr.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / span) * h).toFixed(1)}`).join(' ')
}

// ---- managed-cluster badge ----
function managedOf(node: TopologyNode): string | null {
  return states[node.connectionId]?.status?.managedBy ?? null
}

// ---- threshold alerts (edge-triggered desktop notifications) ----
const alerts = ref(true)
const prevSeverity: Record<string, string> = {}
let seeded = false

function severityOf(node: TopologyNode): string {
  if (states[node.connectionId]?.phase === 'down') return 'down'
  return nodeView(node).color // green | amber | red | grey
}
function notify(title: string, body: string): void {
  if (!alerts.value || !('Notification' in window)) return
  if (Notification.permission === 'granted') new Notification(title, { body })
  else if (Notification.permission !== 'denied')
    void Notification.requestPermission().then((p) => {
      if (p === 'granted') new Notification(title, { body })
    })
}
/** Fire one notification per node that newly entered "unreachable" or "critical lag". */
function checkAlerts(): void {
  const t = topology.value
  if (!t) return
  for (const node of t.nodes) {
    const id = node.connectionId
    const sev = severityOf(node)
    const prev = prevSeverity[id]
    prevSeverity[id] = sev
    if (!seeded || prev === undefined || sev === prev) continue
    if (sev === 'down') notify(t.name, `${connName(id)} is unreachable`)
    else if (sev === 'red')
      notify(t.name, `${connName(id)} replication lag is critical (${fmtLag(states[id]?.status?.lagSeconds)})`)
  }
  seeded = true
}

// ---- AI advisor (read-only: diagnoses, recommends; never executes) ----
const aiReady = ref(false)
const advisorOpen = ref(false)
const advice = ref('')
const advising = ref(false)
const adviseErr = ref('')

function snapshot() {
  return (topology.value?.nodes ?? []).map((n) => {
    const st = states[n.connectionId]
    const s = st?.status
    return {
      name: connName(n.connectionId),
      driver: connDriver(n.connectionId),
      assignedRole: n.role,
      detectedRole: s?.detectedRole,
      isPrimary: s?.isPrimary,
      lagSeconds: s?.lagSeconds ?? null,
      position: s?.position,
      replicas: s?.replicas?.map((r) => ({ name: r.name, state: r.state, lagSeconds: r.lagSeconds })),
      managedBy: s?.managedBy ?? null,
      detail: s?.detail,
      error: s?.error,
      unreachable: st?.phase === 'down',
      notConnected: st?.phase === 'offline'
    }
  })
}

async function runAdvisor(): Promise<void> {
  advisorOpen.value = true
  advising.value = true
  adviseErr.value = ''
  try {
    advice.value = await window.api.ai.adviseReplication({
      topology: topology.value?.name ?? 'Topology',
      warnSeconds: warn.value,
      critSeconds: crit.value,
      nodes: snapshot()
    })
  } catch (e) {
    adviseErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    advising.value = false
  }
}

// ---- polling ----
const refreshMs = ref(4000)
const auto = ref(true)
const lastAt = ref(0)
const refreshing = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

async function pollNode(node: TopologyNode): Promise<void> {
  const id = node.connectionId
  if (ws.connStates[id] !== 'connected') {
    states[id] = { phase: 'offline' }
    return
  }
  const prev = states[id]
  states[id] = { ...prev, phase: prev?.status ? 'ok' : 'loading' }
  try {
    const status = await window.api.db.replicationStatus(id)
    states[id] = { phase: 'ok', status, at: Date.now() }
    if (!status.isPrimary && status.lagSeconds != null) pushHistory(id, status.lagSeconds)
  } catch (e) {
    states[id] = { phase: 'down', err: e instanceof Error ? e.message : String(e), at: Date.now() }
  }
}

async function refresh(): Promise<void> {
  if (!topology.value) return
  refreshing.value = true
  try {
    await Promise.all(topology.value.nodes.map(pollNode))
    lastAt.value = Date.now()
    checkAlerts()
  } finally {
    refreshing.value = false
    await nextTick()
    recomputeLinks()
  }
}

async function connectAll(): Promise<void> {
  if (!topology.value) return
  await Promise.all(
    topology.value.nodes.map((n) => ws.ensureConnected(n.connectionId).catch(() => undefined))
  )
  await refresh()
}

function restartTimer(): void {
  if (timer) clearInterval(timer)
  if (auto.value) timer = setInterval(refresh, refreshMs.value)
}
watch([auto, refreshMs], restartTimer)
watch(
  () => props.topologyId,
  () => {
    for (const k of Object.keys(history)) delete history[k]
    for (const k of Object.keys(prevSeverity)) delete prevSeverity[k]
    seeded = false
    void refresh()
  }
)

function openNode(id: string): void {
  ws.connectAndOpen(id)
  ui.closeTopology()
}

// ---- connector lines (SVG overlay computed from card positions) ----
const board = ref<HTMLElement>()
interface Line {
  x1: number
  y1: number
  x2: number
  y2: number
  color: Color
  label: string
}
const lines = ref<Line[]>([])

function cardCenter(id: string, edge: 'bottom' | 'top'): { x: number; y: number } | null {
  const el = board.value?.querySelector(`[data-node="${id}"]`) as HTMLElement | null
  const root = board.value
  if (!el || !root) return null
  const r = el.getBoundingClientRect()
  const b = root.getBoundingClientRect()
  return {
    x: r.left - b.left + r.width / 2 + root.scrollLeft,
    y: (edge === 'bottom' ? r.bottom : r.top) - b.top + root.scrollTop
  }
}

function recomputeLinks(): void {
  const t = topology.value
  if (!t || !board.value) {
    lines.value = []
    return
  }
  const prim = primaries.value[0]
  if (!prim) {
    lines.value = []
    return
  }
  const from = cardCenter(prim.connectionId, 'bottom')
  if (!from) {
    lines.value = []
    return
  }
  const out: Line[] = []
  for (const node of others.value) {
    const to = cardCenter(node.connectionId, 'top')
    if (!to) continue
    const v = nodeView(node)
    out.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y, color: v.color, label: fmtLag(v.lag) })
  }
  lines.value = out
}

let resizeObs: ResizeObserver | undefined
onMounted(() => {
  void refresh()
  restartTimer()
  void window.api.ai.hasKey().then((r) => (aiReady.value = r))
  if (board.value && 'ResizeObserver' in window) {
    resizeObs = new ResizeObserver(() => recomputeLinks())
    resizeObs.observe(board.value)
  }
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  clearInterval(sinceTimer)
  resizeObs?.disconnect()
})

const sinceLabel = ref('')
const sinceTimer = setInterval(() => {
  if (!lastAt.value) { sinceLabel.value = ''; return }
  const s = Math.round((Date.now() - lastAt.value) / 1000)
  sinceLabel.value = s <= 1 ? 'just now' : `${s}s ago`
}, 1000)
</script>

<template>
  <div class="topo-panel">
    <header class="topo-bar">
      <button class="back" title="Back" @click="ui.closeTopology()">←</button>
      <div class="title-wrap">
        <h1>{{ topology?.name ?? 'Topology' }}</h1>
        <span class="sub">{{ topology?.nodes.length ?? 0 }} nodes · updated {{ sinceLabel || '—' }}</span>
      </div>
      <div class="bar-actions">
        <button class="btn" @click="connectAll">Connect all</button>
        <label class="auto">
          <input type="checkbox" v-model="auto" /> Auto
        </label>
        <label class="auto" title="Desktop notification when a node goes down or lag turns critical">
          <input type="checkbox" v-model="alerts" /> Alerts
        </label>
        <select class="select small" v-model.number="refreshMs">
          <option :value="2000">2s</option>
          <option :value="4000">4s</option>
          <option :value="10000">10s</option>
          <option :value="30000">30s</option>
        </select>
        <button class="btn" :class="{ spin: refreshing }" title="Refresh now" @click="refresh">↻</button>
        <button v-if="aiReady" class="btn ai" title="Ask AI to diagnose this topology" @click="runAdvisor">✦ Advisor</button>
        <button v-if="topology" class="btn" @click="emit('edit', topology)">Edit</button>
      </div>
    </header>

    <div v-if="!topology" class="empty">This topology no longer exists.</div>

    <div v-else ref="board" class="board">
      <!-- connector lines + lag chips -->
      <svg class="links" :width="board?.scrollWidth || 0" :height="board?.scrollHeight || 0">
        <line
          v-for="(l, i) in lines"
          :key="i"
          :x1="l.x1" :y1="l.y1" :x2="l.x2" :y2="l.y2"
          :class="['link', l.color]"
        />
        <g v-for="(l, i) in lines" :key="'lbl' + i">
          <rect :x="(l.x1 + l.x2) / 2 - 20" :y="(l.y1 + l.y2) / 2 - 10" width="40" height="18" rx="9" :class="['chip', l.color]" />
          <text :x="(l.x1 + l.x2) / 2" :y="(l.y1 + l.y2) / 2 + 3" class="chip-text">{{ l.label }}</text>
        </g>
      </svg>

      <!-- primaries -->
      <div class="tier">
        <div v-if="!primaries.length" class="tier-hint">No node is marked Primary — assign one in Edit.</div>
        <template v-for="node in primaries" :key="node.connectionId">
          <div class="node" :data-node="node.connectionId" :class="nodeView(node).color" @click="openNode(node.connectionId)">
            <div class="node-head">
              <span class="drv">{{ connDriver(node.connectionId).toUpperCase().slice(0, 4) }}</span>
              <span class="nm" :title="connName(node.connectionId)">{{ connName(node.connectionId) }}</span>
              <span class="dot" :class="nodeView(node).color" />
            </div>
            <div class="role-row">
              <span class="role primary">PRIMARY</span>
              <span class="status">{{ nodeView(node).badge }}</span>
              <span v-if="managedOf(node)" class="mng" :title="`Managed by ${managedOf(node)}`">⚙ {{ managedOf(node) }}</span>
            </div>
            <p v-for="(d, i) in nodeView(node).detail" :key="i" class="detail">{{ d }}</p>
            <p v-if="nodeView(node).position" class="pos">@ {{ nodeView(node).position }}</p>
          </div>
        </template>
      </div>

      <!-- replicas / arbiters -->
      <div class="tier replicas">
        <template v-for="node in others" :key="node.connectionId">
          <div class="node" :data-node="node.connectionId" :class="nodeView(node).color" @click="openNode(node.connectionId)">
            <div class="node-head">
              <span class="drv">{{ connDriver(node.connectionId).toUpperCase().slice(0, 4) }}</span>
              <span class="nm" :title="connName(node.connectionId)">{{ connName(node.connectionId) }}</span>
              <span class="dot" :class="nodeView(node).color" />
            </div>
            <div class="role-row">
              <span class="role" :class="node.role">{{ node.role.toUpperCase() }}</span>
              <span class="status">{{ nodeView(node).badge }}</span>
              <span v-if="managedOf(node)" class="mng" :title="`Managed by ${managedOf(node)}`">⚙ {{ managedOf(node) }}</span>
              <span v-if="nodeView(node).lag != null" class="lag" :class="nodeView(node).color">{{ fmtLag(nodeView(node).lag) }}</span>
            </div>
            <svg v-if="hasSpark(node.connectionId)" class="spark" viewBox="0 0 120 22" preserveAspectRatio="none">
              <polyline :points="sparkPoints(node.connectionId, 120, 22)" :class="nodeView(node).color" />
            </svg>
            <p
              v-if="nodeView(node).detected && nodeView(node).detected !== node.role && nodeView(node).detected !== 'unknown'"
              class="detail mismatch"
            >⚠ engine reports: {{ nodeView(node).detected }}</p>
            <p v-for="(d, i) in nodeView(node).detail" :key="i" class="detail">{{ d }}</p>
            <p v-if="nodeView(node).position" class="pos">@ {{ nodeView(node).position }}</p>
          </div>
        </template>
      </div>
    </div>

    <!-- AI advisor drawer (read-only diagnosis) -->
    <aside v-if="advisorOpen" class="advisor">
      <header class="adv-head">
        <span class="adv-title">✦ Replication advisor</span>
        <button class="btn" :class="{ spin: advising }" title="Re-run" @click="runAdvisor">↻</button>
        <button class="adv-close" title="Close" @click="advisorOpen = false">✕</button>
      </header>
      <div class="adv-body">
        <div v-if="advising && !advice" class="adv-state">Analyzing the topology…</div>
        <div v-else-if="adviseErr" class="adv-state err">{{ adviseErr }}</div>
        <div v-else class="adv-text">{{ advice }}</div>
      </div>
      <p class="adv-foot">⚠ Advice only — DataDock executes nothing. Review every command before you run it.</p>
    </aside>
  </div>
</template>

<style scoped>
.topo-panel {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
}
.topo-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
}
.back {
  font-size: 18px;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  color: var(--text-dim);
}
.back:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.title-wrap {
  flex: 1;
}
.title-wrap h1 {
  font-size: 15px;
  font-weight: 700;
  margin: 0;
}
.sub {
  font-size: 11.5px;
  color: var(--text-faint);
}
.bar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.auto {
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 4px;
}
.select.small {
  padding: 3px 6px;
  font-size: 12px;
}
.btn.spin {
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
}
.board {
  position: relative;
  flex: 1;
  overflow: auto;
  padding: 40px;
  display: flex;
  flex-direction: column;
  gap: 90px;
}
.links {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}
.link {
  stroke-width: 2.5;
  stroke-dasharray: 7 5;
  animation: dash 0.8s linear infinite;
}
@keyframes dash {
  to { stroke-dashoffset: -12; }
}
.link.green { stroke: var(--ok, #3fcf8e); }
.link.amber { stroke: var(--warn, #f0b429); }
.link.red { stroke: var(--danger, #e5616a); }
.link.grey { stroke: var(--border-strong, #555); stroke-dasharray: 4 6; }
.chip.green { fill: var(--ok, #3fcf8e); }
.chip.amber { fill: var(--warn, #f0b429); }
.chip.red { fill: var(--danger, #e5616a); }
.chip.grey { fill: var(--bg-elevated); stroke: var(--border); }
.chip-text {
  fill: #08110d;
  font-size: 10.5px;
  font-weight: 700;
  text-anchor: middle;
  font-family: var(--mono);
}
.chip.grey + .chip-text,
.tier .grey {
  fill: var(--text-dim);
}
.tier {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 24px;
}
.tier-hint {
  color: var(--text-faint);
  font-size: 12.5px;
}
.node {
  width: 240px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.1s;
}
.node:hover {
  transform: translateY(-2px);
  border-color: var(--border-strong);
}
.node.green { border-color: rgba(63, 207, 142, 0.6); box-shadow: 0 0 0 1px rgba(63, 207, 142, 0.25); }
.node.amber { border-color: rgba(240, 180, 41, 0.7); box-shadow: 0 0 0 1px rgba(240, 180, 41, 0.3); }
.node.red { border-color: rgba(229, 97, 106, 0.7); box-shadow: 0 0 0 1px rgba(229, 97, 106, 0.3); }
.node-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.drv {
  font-family: var(--mono);
  font-size: 9.5px;
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 2px 5px;
}
.nm {
  flex: 1;
  font-weight: 600;
  font-size: 13.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--border-strong);
}
.dot.green { background: var(--ok, #3fcf8e); }
.dot.amber { background: var(--warn, #f0b429); }
.dot.red { background: var(--danger, #e5616a); box-shadow: 0 0 6px var(--danger, #e5616a); }
.role-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 9px 0 4px;
}
.role {
  font-size: 9.5px;
  font-weight: 800;
  letter-spacing: 0.05em;
  padding: 2px 6px;
  border-radius: 5px;
  color: var(--text-dim);
  background: var(--bg-active);
}
.role.primary {
  color: #1a1205;
  background: var(--gold, #e0a14a);
}
.status {
  font-size: 12px;
  color: var(--text-dim);
}
.lag {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
}
.lag.green { color: var(--ok, #3fcf8e); }
.lag.amber { color: var(--warn, #f0b429); }
.lag.red { color: var(--danger, #e5616a); }
.mng {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--text-dim);
  background: var(--bg-active);
  border-radius: 5px;
  padding: 2px 6px;
  white-space: nowrap;
}
.spark {
  width: 100%;
  height: 22px;
  margin: 8px 0 2px;
  display: block;
  overflow: visible;
}
.spark polyline {
  fill: none;
  stroke-width: 1.6;
  vector-effect: non-scaling-stroke;
}
.spark polyline.green { stroke: var(--ok, #3fcf8e); }
.spark polyline.amber { stroke: var(--warn, #f0b429); }
.spark polyline.red { stroke: var(--danger, #e5616a); }
.spark polyline.grey { stroke: var(--border-strong); }
/* ---- AI advisor drawer ---- */
.btn.ai {
  color: var(--accent);
  border-color: rgba(45, 212, 191, 0.4);
}
.advisor {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 420px;
  max-width: 92vw;
  z-index: 5;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border-left: 1px solid var(--border);
  box-shadow: -18px 0 48px rgba(0, 0, 0, 0.4);
}
.adv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.adv-title {
  flex: 1;
  font-weight: 700;
  font-size: 13.5px;
  color: var(--accent);
}
.adv-close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--text-dim);
}
.adv-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.adv-body {
  flex: 1;
  overflow: auto;
  padding: 14px 16px;
}
.adv-text {
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}
.adv-state {
  font-size: 13px;
  color: var(--text-dim);
}
.adv-state.err {
  color: var(--danger);
}
.adv-foot {
  margin: 0;
  padding: 9px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-faint);
}
.detail {
  font-size: 11.5px;
  color: var(--text-faint);
  margin: 2px 0 0;
  line-height: 1.4;
}
.detail.mismatch {
  color: var(--warn, #f0b429);
}
.pos {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-faint);
  margin: 5px 0 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
