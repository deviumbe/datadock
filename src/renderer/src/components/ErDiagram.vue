<script setup lang="ts">
import { ref, reactive, watch, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { ErModel } from '@shared/types'

const props = defineProps<{ model: ErModel | null; running?: boolean }>()
const emit = defineEmits<{ reload: [] }>()

const W      = 220
const HEADER = 30
const ROW    = 20
const HGAP   = 64
const VGAP   = 80
const PAD    = 48

const MIN_ZOOM  = 0.15
const MAX_ZOOM  = 3.0
const ZOOM_STEP = 0.12

const container = ref<HTMLElement>()
const positions  = reactive<Record<string, { x: number; y: number }>>({})
const zoom       = ref(1.0)

const zoomPct = computed(() => `${Math.round(zoom.value * 100)}%`)

function heightOf(name: string): number {
  const t = props.model?.tables.find((x) => x.name === name)
  return HEADER + (t ? t.columns.length : 0) * ROW + 8
}

// ---- layout ------------------------------------------------------------------

function layout(): void {
  const tables    = props.model?.tables    ?? []
  const relations = props.model?.relations ?? []
  if (tables.length === 0) return

  const names = new Set(tables.map((t) => t.name))

  const childrenOf = new Map<string, Set<string>>()
  const parentsOf  = new Map<string, Set<string>>()
  for (const t of tables) {
    childrenOf.set(t.name, new Set())
    parentsOf.set(t.name, new Set())
  }
  for (const rel of relations) {
    if (rel.fromTable === rel.toTable) continue
    if (!names.has(rel.fromTable) || !names.has(rel.toTable)) continue
    childrenOf.get(rel.toTable)?.add(rel.fromTable)
    parentsOf.get(rel.fromTable)?.add(rel.toTable)
  }

  const depth    = new Map<string, number>(tables.map((t) => [t.name, 0]))
  const inDegree = new Map<string, number>(tables.map((t) => [t.name, parentsOf.get(t.name)!.size]))
  const visited  = new Set<string>()
  const queue    = tables.filter((t) => inDegree.get(t.name) === 0).map((t) => t.name)

  while (queue.length > 0) {
    const name = queue.shift()!
    visited.add(name)
    for (const child of childrenOf.get(name) ?? []) {
      const nd = depth.get(name)! + 1
      if (nd > depth.get(child)!) depth.set(child, nd)
      const ni = (inDegree.get(child) ?? 1) - 1
      inDegree.set(child, ni)
      if (ni <= 0 && !visited.has(child)) queue.push(child)
    }
  }
  const maxDepth = tables.reduce((m, t) => Math.max(m, depth.get(t.name)!), 0)
  for (const t of tables) if (!visited.has(t.name)) depth.set(t.name, maxDepth + 1)

  const layers = new Map<number, string[]>()
  for (const t of tables) {
    const d = depth.get(t.name)!
    if (!layers.has(d)) layers.set(d, [])
    layers.get(d)!.push(t.name)
  }
  for (const arr of layers.values()) arr.sort()
  const sortedDepths = [...layers.keys()].sort((a, b) => a - b)

  const layerW    = (d: number) => layers.get(d)!.length * W + (layers.get(d)!.length - 1) * HGAP
  const maxLayerW = sortedDepths.reduce((m, d) => Math.max(m, layerW(d)), 0)

  let y = PAD
  for (const d of sortedDepths) {
    const row   = layers.get(d)!
    const xBase = PAD + (maxLayerW - layerW(d)) / 2
    let rowMaxH = 0
    for (let i = 0; i < row.length; i++) {
      positions[row[i]] = { x: xBase + i * (W + HGAP), y }
      rowMaxH = Math.max(rowMaxH, heightOf(row[i]))
    }
    y += rowMaxH + VGAP
  }
}

watch(() => props.model, (m) => { if (m) layout() }, { immediate: true })

// ---- canvas size & scaled wrapper -------------------------------------------

const canvasSize = computed(() => {
  let w = 600, h = 400
  for (const t of props.model?.tables ?? []) {
    const p = positions[t.name]
    if (!p) continue
    w = Math.max(w, p.x + W + 70)
    h = Math.max(h, p.y + heightOf(t.name) + 70)
  }
  return { w, h }
})

/** The outer spacer div must match the scaled canvas so scroll bars are correct. */
const scaledSize = computed(() => ({
  w: Math.ceil(canvasSize.value.w * zoom.value),
  h: Math.ceil(canvasSize.value.h * zoom.value)
}))

// ---- zoom --------------------------------------------------------------------

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

function applyZoom(newZoom: number, pivotViewX?: number, pivotViewY?: number): void {
  const el = container.value
  if (!el) return
  const old = zoom.value
  newZoom = clampZoom(newZoom)
  if (newZoom === old) return

  // Canvas coords under the pivot point before zoom.
  const pvx = pivotViewX ?? el.clientWidth  / 2
  const pvy = pivotViewY ?? el.clientHeight / 2
  const canvX = (el.scrollLeft + pvx) / old
  const canvY = (el.scrollTop  + pvy) / old

  zoom.value = newZoom

  nextTick(() => {
    el.scrollLeft = canvX * newZoom - pvx
    el.scrollTop  = canvY * newZoom - pvy
  })
}

function zoomIn():  void { applyZoom(zoom.value + ZOOM_STEP) }
function zoomOut(): void { applyZoom(zoom.value - ZOOM_STEP) }

function fitView(): void {
  const el     = container.value
  const tables = props.model?.tables ?? []
  if (!el || tables.length === 0) return

  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0
  for (const t of tables) {
    const p = positions[t.name]
    if (!p) continue
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + W)
    maxY = Math.max(maxY, p.y + heightOf(t.name))
  }

  const contentW = maxX - minX + PAD * 2
  const contentH = maxY - minY + PAD * 2
  const newZoom  = clampZoom(Math.min(el.clientWidth / contentW, el.clientHeight / contentH) * 0.93)
  zoom.value = newZoom

  nextTick(() => {
    el.scrollLeft = (minX - PAD) * newZoom
    el.scrollTop  = (minY - PAD) * newZoom
  })
}

function resetZoom(): void {
  zoom.value = 1.0
  nextTick(() => {
    if (container.value) {
      container.value.scrollLeft = 0
      container.value.scrollTop  = 0
    }
  })
}

// Wheel: zoom on Ctrl/Meta + scroll (also handles trackpad pinch → ctrlKey=true).
function onWheel(e: WheelEvent): void {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    const el   = container.value!
    const rect = el.getBoundingClientRect()
    const pvx  = e.clientX - rect.left
    const pvy  = e.clientY - rect.top
    // Normalize: mouse wheel gives ±100, trackpad pinch gives small values.
    const raw   = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY   // line→px
    const delta = raw > 0 ? -ZOOM_STEP : ZOOM_STEP
    applyZoom(zoom.value + delta, pvx, pvy)
  }
  // Plain scroll — let the browser handle it natively.
}

// Keyboard: ⌘+  ⌘-  ⌘0  when the diagram is focused.
function onKeydown(e: KeyboardEvent): void {
  if (!e.metaKey && !e.ctrlKey) return
  if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn() }
  else if (e.key === '-')             { e.preventDefault(); zoomOut() }
  else if (e.key === '0')             { e.preventDefault(); resetZoom() }
}

onMounted(() => {
  // Must be non-passive so we can call preventDefault for ctrl+wheel.
  container.value?.addEventListener('wheel', onWheel, { passive: false })
})
onBeforeUnmount(() => {
  container.value?.removeEventListener('wheel', onWheel)
})

// ---- edges -------------------------------------------------------------------

interface Edge { d: string }
const edges = computed<Edge[]>(() => {
  const out: Edge[] = []
  for (const rel of props.model?.relations ?? []) {
    if (rel.fromTable === rel.toTable) continue
    const from = positions[rel.fromTable]
    const to   = positions[rel.toTable]
    if (!from || !to) continue

    const fromH  = heightOf(rel.fromTable)
    const toH    = heightOf(rel.toTable)
    const fromCX = from.x + W / 2
    const toCX   = to.x   + W / 2
    const fromCY = from.y + fromH / 2
    const toCY   = to.y   + toH   / 2
    const dx     = Math.abs(fromCX - toCX)
    const dy     = Math.abs(fromCY - toCY)

    let d: string
    if (dy > dx) {
      const upperY = fromCY < toCY ? from.y + fromH : to.y + toH
      const lowerY = fromCY < toCY ? to.y            : from.y
      const upperX = fromCY < toCY ? fromCX           : toCX
      const lowerX = fromCY < toCY ? toCX             : fromCX
      const cy = (upperY + lowerY) / 2
      d = `M ${upperX} ${upperY} C ${upperX} ${cy}, ${lowerX} ${cy}, ${lowerX} ${lowerY}`
    } else {
      const sy = fromCY, ty = toCY
      const rightward = toCX >= fromCX
      const sx = from.x + (rightward ? W : 0)
      const tx = to.x   + (rightward ? 0 : W)
      const cx = Math.abs(tx - sx) * 0.5 + 30
      d = `M ${sx} ${sy} C ${sx + (rightward ? cx : -cx)} ${sy}, ${tx + (rightward ? -cx : cx)} ${ty}, ${tx} ${ty}`
    }
    out.push({ d })
  }
  return out
})

// ---- drag (zoom-aware coordinates) ------------------------------------------

let dragName: string | null = null
let grabX = 0, grabY = 0

function canvasCoord(e: MouseEvent): { x: number; y: number } {
  const el = container.value!
  return {
    x: (e.clientX - el.getBoundingClientRect().left + el.scrollLeft) / zoom.value,
    y: (e.clientY - el.getBoundingClientRect().top  + el.scrollTop)  / zoom.value
  }
}

function startDrag(name: string, e: MouseEvent): void {
  const c = canvasCoord(e)
  dragName = name
  grabX = c.x - positions[name].x
  grabY = c.y - positions[name].y
  window.addEventListener('mousemove', onDrag)
  window.addEventListener('mouseup',   endDrag)
}
function onDrag(e: MouseEvent): void {
  if (!dragName) return
  const c = canvasCoord(e)
  positions[dragName] = { x: Math.max(0, c.x - grabX), y: Math.max(0, c.y - grabY) }
}
function endDrag(): void {
  dragName = null
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup',   endDrag)
}
</script>

<template>
  <div class="er" @keydown="onKeydown" tabindex="0">
    <div class="er-toolbar">
      <strong>Schema Diagram</strong>
      <span class="muted">
        {{ model?.tables.length || 0 }} tables · {{ model?.relations.length || 0 }} relations
      </span>
      <div class="spacer" />
      <span class="hint">Drag to rearrange · ⌘scroll to zoom</span>

      <!-- Zoom controls -->
      <div class="zoom-group">
        <button class="btn btn-ghost zoom-btn" title="Zoom out (⌘−)" @click="zoomOut">−</button>
        <button class="zoom-label btn btn-ghost" title="Reset zoom (⌘0)" @click="resetZoom">{{ zoomPct }}</button>
        <button class="btn btn-ghost zoom-btn" title="Zoom in (⌘+)" @click="zoomIn">＋</button>
      </div>
      <button class="btn btn-ghost" title="Fit diagram to view" @click="fitView">⊞ Fit</button>
      <button class="btn btn-ghost" @click="layout()">Re-layout</button>
      <button class="btn btn-ghost" @click="emit('reload')">⟳</button>
    </div>

    <div ref="container" class="er-canvas">
      <div v-if="model && model.tables.length === 0" class="empty">No tables to diagram.</div>

      <!-- Spacer reserves the correct scroll area for the scaled content. -->
      <div v-else class="er-spacer" :style="{ width: scaledSize.w + 'px', height: scaledSize.h + 'px' }">
        <div
          class="er-inner"
          :style="{
            width:           canvasSize.w + 'px',
            height:          canvasSize.h + 'px',
            transform:       `scale(${zoom})`,
            transformOrigin: '0 0'
          }"
        >
          <svg class="er-edges" :width="canvasSize.w" :height="canvasSize.h">
            <defs>
              <marker id="er-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--text-faint)" />
              </marker>
            </defs>
            <path
              v-for="(e, i) in edges"
              :key="i"
              :d="e.d"
              class="edge"
              marker-end="url(#er-arrow)"
            />
          </svg>

          <div
            v-for="t in model?.tables || []"
            :key="t.name"
            class="node"
            :style="{ left: `${positions[t.name]?.x}px`, top: `${positions[t.name]?.y}px`, width: `${W}px` }"
          >
            <div class="node-head" @mousedown.prevent="startDrag(t.name, $event)">{{ t.name }}</div>
            <div v-for="c in t.columns" :key="c.name" class="node-col">
              <span class="col-name" :class="{ pkcol: c.isPrimaryKey }">{{ c.name }}</span>
              <span class="col-badges">
                <span v-if="c.isPrimaryKey" class="b pk">PK</span>
                <span v-if="c.isForeignKey" class="b fk">FK</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.er {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  outline: none; /* tabindex focus ring suppressed */
}
.er-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.er-toolbar .muted {
  color: var(--text-faint);
  font-size: 12px;
}
.er-toolbar .hint {
  color: var(--text-faint);
  font-size: 11px;
}
.spacer { flex: 1; }

/* zoom controls */
.zoom-group {
  display: flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.zoom-group .btn {
  border: none;
  border-radius: 0;
  padding: 3px 8px;
  font-size: 13px;
}
.zoom-group .btn + .btn {
  border-left: 1px solid var(--border);
}
.zoom-label {
  min-width: 44px;
  text-align: center;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-dim);
}
.zoom-btn {
  font-size: 16px;
  line-height: 1;
  color: var(--text-dim);
}

.er-canvas {
  flex: 1;
  overflow: auto;
  position: relative;
  background:
    radial-gradient(var(--border) 1px, transparent 1px) 0 0 / 22px 22px;
  background-color: var(--bg-app);
}
/* The spacer makes the scrollbar track the zoomed content size. */
.er-spacer {
  position: relative;
}
.er-inner {
  position: absolute;
  top: 0;
  left: 0;
}
.er-edges {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.edge {
  fill: none;
  stroke: var(--text-faint);
  stroke-width: 1.5;
  opacity: 0.7;
}
.node {
  position: absolute;
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  font-size: 12px;
}
.node-head {
  height: 30px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  font-weight: 700;
  background: var(--accent-soft);
  color: var(--accent);
  cursor: grab;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
}
.node-head:active { cursor: grabbing; }
.node-col {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 20px;
  padding: 0 10px;
  border-top: 1px solid var(--border);
  font-family: var(--mono);
}
.col-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-name.pkcol { font-weight: 600; }
.col-badges { display: flex; gap: 3px; flex-shrink: 0; }
.b {
  font-size: 8px;
  font-weight: 700;
  padding: 0 3px;
  border-radius: 3px;
  line-height: 14px;
}
.b.pk { background: var(--accent-soft); color: var(--accent); }
.b.fk { background: rgba(91,141,239,0.18); color: #5b8def; }
.empty { padding: 40px; color: var(--text-faint); }
</style>
