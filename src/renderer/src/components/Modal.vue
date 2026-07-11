<script lang="ts">
// Escape closes only the topmost modal when dialogs stack (e.g. a confirm
// prompt over settings), so one keypress never dismisses the whole stack.
const modalStack: symbol[] = []
</script>

<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
const props = defineProps<{ title: string; wide?: boolean; busy?: boolean }>()
const emit = defineEmits<{ close: [] }>()

// While an operation is running, ignore backdrop clicks, the ✕ and Escape so a
// stray input can't abandon it. The footer's own buttons control closing instead.
function requestClose(): void {
  if (!props.busy) emit('close')
}

const modalId = Symbol('modal')
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && modalStack[modalStack.length - 1] === modalId) requestClose()
}
onMounted(() => {
  modalStack.push(modalId)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  modalStack.splice(modalStack.indexOf(modalId), 1)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal" appear>
      <div class="overlay" @mousedown.self="requestClose">
        <div class="modal" :class="{ wide }">
          <header class="modal-head">
            <h2>{{ title }}</h2>
            <button class="btn-ghost close" title="Close" :disabled="busy" @click="requestClose">
              <Icon name="x" :size="14" />
            </button>
          </header>
          <div class="modal-body">
            <slot />
          </div>
          <footer class="modal-foot" v-if="$slots.footer">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(3px);
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  transition: background var(--dur-1), color var(--dur-1);
}
.close:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.close:disabled {
  opacity: 0.35;
  cursor: not-allowed;
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

/* Entrance: backdrop fades while the panel rises and settles. */
.modal-enter-active {
  transition: opacity var(--dur-2) ease;
}
.modal-enter-active .modal {
  transition: transform var(--dur-3) var(--ease-out), opacity var(--dur-2) ease;
}
.modal-leave-active {
  transition: opacity var(--dur-1) ease;
}
.modal-enter-from {
  opacity: 0;
}
.modal-enter-from .modal {
  opacity: 0;
  transform: translateY(14px) scale(0.97);
}
.modal-leave-to {
  opacity: 0;
}
</style>
