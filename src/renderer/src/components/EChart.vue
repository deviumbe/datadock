<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as echarts from 'echarts'

const props = defineProps<{ option: echarts.EChartsCoreOption | null }>()

const el = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
let ro: ResizeObserver | null = null

function render(): void {
  if (!chart || !props.option) return
  // `true` (notMerge) so removing series/axes between specs doesn't leave stale state.
  chart.setOption(props.option, true)
}

onMounted(() => {
  if (!el.value) return
  chart = echarts.init(el.value, null, { renderer: 'canvas' })
  render()
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
