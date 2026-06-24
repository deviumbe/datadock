<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as echarts from 'echarts'

const props = defineProps<{ option: echarts.EChartsCoreOption | null }>()
const emit = defineEmits<{ pointClick: [{ name: string; seriesName?: string }] }>()

const el = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
let ro: ResizeObserver | null = null

function render(): void {
  if (!chart || !props.option) return
  // `true` (notMerge) so removing series/axes between specs doesn't leave stale state.
  chart.setOption(props.option, true)
}

/** A PNG data-URL snapshot of the current chart, for PDF/report export. */
function image(): string | null {
  if (!chart) return null
  try {
    return chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: 'transparent' })
  } catch {
    return null
  }
}
defineExpose({ image })

onMounted(() => {
  if (!el.value) return
  chart = echarts.init(el.value, null, { renderer: 'canvas' })
  render()
  chart.on('click', (p: { name?: string; seriesName?: string }) => {
    if (p && p.name !== undefined) emit('pointClick', { name: String(p.name), seriesName: p.seriesName })
  })
  ro = new ResizeObserver(() => chart?.resize())
  ro.observe(el.value)
})

watch(() => props.option, render, { deep: true })

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div ref="el" class="echart" />
</template>

<style scoped>
.echart {
  width: 100%;
  height: 100%;
  min-height: 0;
}
</style>
