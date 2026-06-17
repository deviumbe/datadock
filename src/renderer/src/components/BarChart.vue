<script setup lang="ts">
import { computed, ref } from 'vue'

interface Bar {
  label: string
  value: number
  title?: string
  alert?: boolean
}
const props = withDefaults(
  defineProps<{
    bars: Bar[]
    height?: number
    /** Max label ticks to render along the x-axis (others blanked). */
    maxTicks?: number
  }>(),
  { height: 160, maxTicks: 8 }
)

const W = 600
const PAD_L = 8
const PAD_R = 8
const PAD_B = 22
const PAD_T = 10

const max = computed(() => Math.max(1, ...props.bars.map((b) => b.value)))
const innerH = computed(() => props.height - PAD_B - PAD_T)
const slot = computed(() => (W - PAD_L - PAD_R) / Math.max(1, props.bars.length))
const barW = computed(() => Math.max(2, slot.value * 0.62))

function x(i: number): number {
  return PAD_L + i * slot.value + (slot.value - barW.value) / 2
}
function h(v: number): number {
  return (v / max.value) * innerH.value
}
function y(v: number): number {
  return PAD_T + innerH.value - h(v)
}
function showTick(i: number): boolean {
  const step = Math.ceil(props.bars.length / props.maxTicks)
  return i % step === 0
}

const hover = ref<number | null>(null)
</script>

<template>
  <div class="chart">
    <svg :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" class="svg">
      <!-- baseline -->
      <line :x1="PAD_L" :x2="W - PAD_R" :y1="PAD_T + innerH" :y2="PAD_T + innerH" class="axis" />
      <g v-for="(b, i) in bars" :key="i" @mouseenter="hover = i" @mouseleave="hover = null">
        <!-- hit area -->
        <rect :x="PAD_L + i * slot" :y="PAD_T" :width="slot" :height="innerH" fill="transparent" />
        <rect
          :x="x(i)"
          :y="y(b.value)"
          :width="barW"
          :height="Math.max(0, h(b.value))"
          rx="2"
          class="bar"
          :class="{ alert: b.alert, on: hover === i }"
        />
      </g>
    </svg>
    <div class="xlabels">
      <span
        v-for="(b, i) in bars"
        :key="i"
        class="xl"
        :style="{ flexBasis: `${100 / bars.length}%` }"
      >{{ showTick(i) ? b.label : '' }}</span>
    </div>
    <div v-if="hover !== null" class="tip">
      {{ bars[hover].title ?? `${bars[hover].label}: ${bars[hover].value}` }}
    </div>
  </div>
</template>

<style scoped>
.chart {
  position: relative;
  width: 100%;
}
.svg {
  width: 100%;
  display: block;
  height: v-bind('height + "px"');
  overflow: visible;
}
.axis {
  stroke: var(--border);
  stroke-width: 1;
}
.bar {
  fill: var(--accent);
  opacity: 0.78;
  transition: opacity 0.12s ease;
}
.bar.on {
  opacity: 1;
}
.bar.alert {
  fill: var(--danger);
}
.xlabels {
  display: flex;
  margin-top: 4px;
}
.xl {
  font-size: 9.5px;
  color: var(--text-faint);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
}
.tip {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 4px 9px;
  font-size: 11px;
  color: var(--text);
  pointer-events: none;
  white-space: nowrap;
  box-shadow: var(--shadow-modal);
}
</style>
