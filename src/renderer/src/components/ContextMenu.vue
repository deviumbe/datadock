<script setup lang="ts">
export interface MenuItem {
  label?: string
  danger?: boolean
  sep?: boolean
  shortcut?: string
  action?: () => void
}
import { onMounted, onBeforeUnmount } from 'vue'
defineProps<{ x: number; y: number; items: MenuItem[] }>()
const emit = defineEmits<{ close: [] }>()

function pick(item: MenuItem): void {
  if (item.sep) return
  item.action?.()
  emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="cm-overlay" @mousedown="emit('close')" @contextmenu.prevent="emit('close')">
      <div class="cm pop-in" :style="{ left: `${x}px`, top: `${y}px` }" @mousedown.stop>
        <template v-for="(it, i) in items" :key="i">
          <div v-if="it.sep" class="cm-sep" />
          <button v-else class="cm-item" :class="{ danger: it.danger }" @click="pick(it)">
            <span class="cm-label">{{ it.label }}</span>
            <span v-if="it.shortcut" class="cm-shortcut">{{ it.shortcut }}</span>
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cm-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
}
.cm {
  position: fixed;
  min-width: 170px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  padding: 4px;
}
.pop-in {
  transform-origin: top left;
  animation: cm-pop var(--dur-2) var(--ease-spring) both;
}
@keyframes cm-pop {
  from {
    opacity: 0;
    transform: scale(0.94) translateY(-3px);
  }
}
.cm-item {
  display: flex;
  align-items: center;
  gap: 18px;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
  color: var(--text);
  transition: background 0.08s, color 0.08s;
}
.cm-label {
  flex: 1;
}
.cm-shortcut {
  font-size: 11px;
  color: var(--text-faint);
}
.cm-item:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.cm-item.danger:hover {
  background: rgba(229, 97, 106, 0.15);
  color: var(--danger);
}
.cm-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
</style>
