<script setup lang="ts">
import { ref, computed } from 'vue'
import { useTasks, type BgTask } from '../stores/tasks'
import ProgressBar from './ProgressBar.vue'

const tasks = useTasks()
const open = ref(false)

const visible = computed(() => tasks.tasks.length > 0)
const lead = computed(() => tasks.running[0])

function pct(t: BgTask): number | null {
  const p = t.progress
  if (!p) return null
  if (p.phase === 'dump' && p.totalRows && p.totalRows > 0)
    return Math.min(100, Math.round(((p.doneRows ?? 0) / p.totalRows) * 100))
  if (p.total > 0) return Math.min(100, Math.round((p.current / p.total) * 100))
  return null
}

const pillLabel = computed(() => {
  if (lead.value) {
    const n = tasks.running.length
    const p = pct(lead.value)
    const base = n > 1 ? `${n} tasks running` : lead.value.title
    return p !== null ? `${base} · ${p}%` : base
  }
  const done = tasks.tasks.length
  return `${done} finished`
})

function icon(t: BgTask): string {
  return t.status === 'running' ? '' : t.status === 'done' ? '✓' : t.status === 'canceled' ? '⊘' : '✕'
}
</script>

<template>
  <div v-if="visible" class="tray">
    <Transition name="pop">
      <div v-if="open" class="panel" @click.stop>
        <header class="phead">
          <span class="ptitle">Background tasks</span>
          <button class="link" @click="tasks.clearFinished()">Clear finished</button>
        </header>
        <div class="list">
          <div v-for="t in tasks.tasks" :key="t.id" class="item" :class="t.status">
            <div class="irow">
              <span class="badge" :class="t.status">
                <span v-if="t.status === 'running'" class="mini-spin" />
                <span v-else>{{ icon(t) }}</span>
              </span>
              <span class="ititle">{{ t.title }}</span>
              <button v-if="t.status === 'running'" class="link danger" @click="tasks.cancel(t.id)">Cancel</button>
              <button v-else class="x" title="Dismiss" @click="tasks.dismiss(t.id)">✕</button>
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

    <button class="pill" :class="{ active: tasks.hasActive }" @click="open = !open">
      <span v-if="tasks.hasActive" class="spin" />
      <span v-else class="dot">●</span>
      <span class="plabel">{{ pillLabel }}</span>
      <span class="caret">{{ open ? '▾' : '▴' }}</span>
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
  font-size: 12px;
  max-width: 340px;
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
  color: var(--ok);
  font-size: 9px;
}
.caret {
  color: var(--text-faint);
  font-size: 10px;
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
  color: var(--accent);
}
.mini-spin {
  width: 10px;
  height: 10px;
  color: var(--accent);
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
  font-size: 12px;
  font-weight: 600;
}
.link {
  background: none;
  border: none;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
}
.link.danger {
  color: var(--danger);
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
  font-size: 11px;
}
.badge.done {
  color: var(--ok);
}
.badge.error {
  color: var(--danger);
}
.badge.canceled {
  color: var(--text-faint);
}
.ititle {
  flex: 1;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.x {
  background: none;
  border: none;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 11px;
}
.ipb {
  margin-top: 8px;
}
.imsg {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
  word-break: break-word;
}
.imsg.err {
  color: var(--danger);
}
.ierrs {
  margin-top: 4px;
  font-size: 11px;
  color: var(--danger);
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
