<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue'
import type { ErModel } from '@shared/types'

const props = defineProps<{ model: ErModel | null; running?: boolean }>()
const emit = defineEmits<{ reload: [] }>()

const W = 220
const HEADER = 30
const ROW = 20

const container = ref<HTMLElement>()
const positions = reactive<Record<string, { x: number; y: number }>>({})

function heightOf(name: string): number {
  const t = props.model?.tables.find((x) => x.name === name)
  return HEADER + (t ? t.columns.length : 0) * ROW + 8
}

/** Arrange tables in a simple grid (also used by the Re-layout button). */
function layout(): void {
  const tables = props.model?.tables ?? []
  const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length)))
  const cellH = 280
  tables.forEach((t, idx) => {
    positions[t.name] = { x: 30 + (idx % cols) * (W + 70), y: 30 + Math.floor(idx / cols) * cellH }
  })
}

watch(
  () => props.model,
  (m) => {
    if (m) layout()
  },
  { immediate: true }
)

const canvasSize = computed(() => {
  let w = 600
  let h = 400
  for (const t of props.model?.tables ?? []) {
    const p = positions[t.name]
    if (!p) continue
    w = Math.max(w, p.x + W + 70)
    h = Math.max(h, p.y + heightOf(t.name) + 70)
  }
  return { w, h }
})

interface Edge {
  d: string
}
const edges = computed<Edge[]>(() => {
  const out: Edge[] = []
  for (const rel of props.model?.relations ?? []) {
    if (rel.fromTable === rel.toTable) continue
    const s = positions[rel.fromTable]
    const t = positions[rel.toTable]
    if (!s || !t) continue
    const sy = s.y + heightOf(rel.fromTable) / 2
    const ty = t.y + heightOf(rel.toTable) / 2
    const rightward = t.x + W / 2 >= s.x + W / 2
    const sx = s.x + (rightward ? W : 0)
    const tx = t.x + (rightward ? 0 : W)
    const dx = Math.abs(tx - sx) * 0.5 + 30
    const c1 = sx + (rightward ? dx : -dx)
    const c2 = tx + (rightward ? -dx : dx)
    out.push({ d: `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ty}, ${tx} ${ty}` })
  }
  return out
})

// ---- dragging (in canvas content coordinates) ------------------------------
let dragName: string | null = null
let grabX = 0
let grabY = 0

function contentX(e: MouseEvent): number {
  const el = container.value!
  return e.clientX - el.getBoundingClientRect().left + el.scrollLeft
}
function contentY(e: MouseEvent): number {
  const el = container.value!
  return e.clientY - el.getBoundingClientRect().top + el.scrollTop
}
function startDrag(name: string, e: MouseEvent): void {
  dragName = name
  grabX = contentX(e) - positions[name].x
  grabY = contentY(e) - positions[name].y
  window.addEventListener('mousemove', onDrag)
  window.addEventListener('mouseup', endDrag)
}
function onDrag(e: MouseEvent): void {
  if (!dragName) return
  positions[dragName] = {
    x: Math.max(0, contentX(e) - grabX),
    y: Math.max(0, contentY(e) - grabY)
  }
}
function endDrag(): void {
  dragName = null
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', endDrag)
}
</script>

<template>
  <div class="er">
    <div class="er-toolbar">
      <strong>Schema Diagram</strong>
      <span class="muted">
        {{ model?.tables.length || 0 }} tables · {{ model?.relations.length || 0 }} relations
      </span>
      <div class="spacer" />
      <span class="hint">Drag tables to rearrange</span>
      <button class="btn btn-ghost" @click="layout()">Re-layout</button>
      <button class="btn btn-ghost" @click="emit('reload')">⟳</button>
    </div>

    <div ref="container" class="er-canvas">
      <div v-if="model && model.tables.length === 0" class="empty">No tables to diagram.</div>
      <div v-else class="er-inner" :style="{ width: `${canvasSize.w}px`, height: `${canvasSize.h}px` }">
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
</template>

<style scoped>
.er {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.er-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
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
.spacer {
  flex: 1;
}
.er-canvas {
  flex: 1;
  overflow: auto;
  position: relative;
  background:
    radial-gradient(var(--border) 1px, transparent 1px) 0 0 / 22px 22px;
  background-color: var(--bg-app);
}
.er-inner {
  position: relative;
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
}
.node-head:active {
  cursor: grabbing;
}
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
.col-name.pkcol {
  font-weight: 600;
}
.col-badges {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
}
.b {
  font-size: 8px;
  font-weight: 700;
  padding: 0 3px;
  border-radius: 3px;
  line-height: 14px;
}
.b.pk {
  background: var(--accent-soft);
  color: var(--accent);
}
.b.fk {
  background: rgba(91, 141, 239, 0.18);
  color: #5b8def;
}
.empty {
  padding: 40px;
  color: var(--text-faint);
}
</style>
