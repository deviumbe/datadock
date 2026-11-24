<script setup lang="ts">
import Icon from './Icon.vue'
import { computed } from 'vue'
import { useTasks, progressPercent, type BgTask } from '../stores/tasks'
import { useUi } from '../stores/ui'
import ProgressBar from './ProgressBar.vue'

const tasks = useTasks()
const ui = useUi()

const visible = computed(() => tasks.tasks.length > 0)
const lead = computed(() => tasks.running[0])
const leadPct = computed(() => (lead.value ? progressPercent(lead.value.progress) : null))

const pillLabel = computed(() => {
  if (lead.value) {
    const n = tasks.running.length
    const p = leadPct.value
    const base = n > 1 ? `${n} tasks running` : lead.value.title
    return p !== null ? `${base} · ${p}%` : base
  }
  const done = tasks.tasks.length
  return `${done} finished`
})

function icon(t: BgTask): string {
  return t.status === 'done' ? 'check' : t.status === 'canceled' ? 'ban' : 'warn'
}
</script>

<template>
  <div v-if="visible" class="tray">
    <Transition name="pop">
      <div v-if="ui.tasksOpen" class="panel" @click.stop>
        <header class="phead">
          <span class="ptitle">Background tasks</span>
          <button class="link" @click="tasks.clearFinished()">Clear finished</button>
        </header>
        <div class="list">
          <div v-for="t in tasks.tasks" :key="t.id" class="item" :class="t.status">
            <div class="irow">
              <span class="badge" :class="t.status">
                <span v-if="t.status === 'running'" class="mini-spin" data-busy />
                <Icon v-else :name="icon(t)" :size="13" />
              </span>
              <span class="ititle">{{ t.title }}</span>
              <button v-if="t.status === 'running'" class="link danger" @click="tasks.cancel(t.id)">Cancel</button>
              <button v-else class="x" title="Dismiss" @click="tasks.dismiss(t.id)"><Icon name="x" :size="12" /></button>
            </div>
            <ProgressBar v-if="t.status === 'running'" :progress="t.progress" class="ipb" />
            <div v-else-if="t.message" class="imsg" :class="{ err: t.status === 'error' }">{{ t.message }}</div>
            <div v-if="t.errors && t.errors.length" class="ierrs">
              {{ t.errors.length }} error(s) — {{ t.errors[0] }}
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <button class="pill" :aria-expanded="ui.tasksOpen" :class="{ active: tasks.hasActive }" @click="ui.tasksOpen = !ui.tasksOpen">
      <span v-if="tasks.hasActive" class="spin" data-busy />
      <span v-else class="dot"><Icon name="check" :size="13" /></span>
      <span class="plabel">{{ pillLabel }}</span>
      <span class="caret"><Icon :name="ui.tasksOpen ? 'chevronDown' : 'chevronUp'" :size="12" /></span>
      <span v-if="lead" class="pbar" :data-busy="leadPct === null || undefined" :class="{ indet: leadPct === null }">
        <span :style="leadPct !== null ? { width: leadPct + '%' } : undefined" />
      </span>
    </button>
  </div>
</template>

<style scoped>
.tray {
  position: fixed;
  right: 14px;
  bottom: 12px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 999px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-modal);
  color: var(--text-dim);
  font-size: var(--fs-sm);
  max-width: 340px;
  position: relative;
  overflow: hidden;
}
.pbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--border);
}
.pbar > span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}
.pbar.indet > span {
  width: 30%;
  animation: pbar-indet 1.2s ease-in-out infinite;
}
@keyframes pbar-indet {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(340%);
  }
}
.pill.active {
  color: var(--text);
  border-color: var(--accent);
}
.plabel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  color: var(--ok-text);
  font-size: var(--fs-xs);
}
.caret {
  color: var(--text-faint);
  font-size: var(--fs-xs);
}
.spin,
.mini-spin {
  display: inline-block;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
.spin {
  width: 12px;
  height: 12px;
  color: var(--accent-text);
}
.mini-spin {
  width: 10px;
  height: 10px;
  color: var(--accent-text);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.panel {
  width: 340px;
  max-height: 60vh;
  overflow-y: auto;
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-modal);
}
.phead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.ptitle {
  font-size: var(--fs-sm);
  font-weight: 600;
}
.link {
  background: none;
  border: none;
  color: var(--accent-text);
  font-size: var(--fs-xs);
  cursor: pointer;
}
.link.danger {
  color: var(--danger-text);
}
.item {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.item:last-child {
  border-bottom: none;
}
.irow {
  display: flex;
  align-items: center;
  gap: 9px;
}
.badge {
  width: 16px;
  display: flex;
  justify-content: center;
  flex: none;
  font-size: var(--fs-xs);
}
.badge.done {
  color: var(--ok-text);
}
.badge.error {
  color: var(--danger-text);
}
.badge.canceled {
  color: var(--text-faint);
}
.ititle {
  flex: 1;
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.x {
  background: none;
  border: none;
  color: var(--text-faint);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
}
.ipb {
  margin-top: 8px;
}
.imsg {
  margin-top: 6px;
  font-size: var(--fs-sm);
  color: var(--text-dim);
  word-break: break-word;
}
.imsg.err {
  color: var(--danger-text);
}
.ierrs {
  margin-top: 4px;
  font-size: var(--fs-xs);
  color: var(--danger-text);
  font-family: var(--mono);
  word-break: break-word;
}
.pop-enter-active,
.pop-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
