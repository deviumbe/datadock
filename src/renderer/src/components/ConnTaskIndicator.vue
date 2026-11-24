<script setup lang="ts">
import { computed } from 'vue'
import { useTasks, progressPercent } from '../stores/tasks'
import { useUi } from '../stores/ui'

const props = defineProps<{ connId: string }>()

const tasks = useTasks()
const ui = useUi()

const task = computed(() => tasks.runningFor(props.connId))
const pct = computed(() => (task.value ? progressPercent(task.value.progress) : null))
</script>

<template>
  <template v-if="task">
    <button class="task-pct" :title="task.title" @click.stop="ui.tasksOpen = true">
      <span class="task-spin" data-busy />{{ pct !== null ? pct + '%' : '' }}
    </button>
    <span class="task-line" :data-busy="pct === null || undefined" :class="{ indet: pct === null }">
      <span :style="pct !== null ? { width: pct + '%' } : undefined" />
    </span>
  </template>
</template>

<style scoped>
.task-pct {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 0 2px;
  background: none;
  border: none;
  color: var(--accent-text);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.task-spin {
  width: 9px;
  height: 9px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: task-spin 0.7s linear infinite;
}
@keyframes task-spin {
  to {
    transform: rotate(360deg);
  }
}
/* Pinned to the bottom edge of the (position: relative) parent row. */
.task-line {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 1px;
  height: 2px;
  border-radius: 1px;
  background: var(--border);
  overflow: hidden;
  pointer-events: none;
}
.task-line > span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}
.task-line.indet > span {
  width: 30%;
  animation: task-indet 1.2s ease-in-out infinite;
}
@keyframes task-indet {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(340%);
  }
}
</style>
