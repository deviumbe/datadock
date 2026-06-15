<script setup lang="ts">
defineProps<{ title: string; wide?: boolean }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <div class="overlay" @mousedown.self="emit('close')">
      <div class="modal" :class="{ wide }">
        <header class="modal-head">
          <h2>{{ title }}</h2>
          <button class="btn-ghost close" @click="emit('close')">✕</button>
        </header>
        <div class="modal-body">
          <slot />
        </div>
        <footer class="modal-foot" v-if="$slots.footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  width: 440px;
  max-width: 92vw;
  max-height: 88vh;
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal.wide {
  width: 560px;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.modal-head h2 {
  font-size: 14px;
  font-weight: 600;
}
.close {
  font-size: 13px;
  color: var(--text-dim);
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
}
.modal-body {
  padding: 18px;
  overflow-y: auto;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  padding: 14px 18px;
  border-top: 1px solid var(--border);
}
</style>
