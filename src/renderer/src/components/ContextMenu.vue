<script setup lang="ts">
export interface MenuItem {
  label?: string
  danger?: boolean
  sep?: boolean
  action?: () => void
}
defineProps<{ x: number; y: number; items: MenuItem[] }>()
const emit = defineEmits<{ close: [] }>()

function pick(item: MenuItem): void {
  if (item.sep) return
  item.action?.()
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div class="cm-overlay" @mousedown="emit('close')" @contextmenu.prevent="emit('close')">
      <div class="cm" :style="{ left: `${x}px`, top: `${y}px` }" @mousedown.stop>
        <template v-for="(it, i) in items" :key="i">
          <div v-if="it.sep" class="cm-sep" />
          <button v-else class="cm-item" :class="{ danger: it.danger }" @click="pick(it)">
            {{ it.label }}
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
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  padding: 4px;
}
.cm-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
  color: var(--text);
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
