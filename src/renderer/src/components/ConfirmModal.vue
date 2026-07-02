<script setup lang="ts">
import { useUi } from '../stores/ui'
import Modal from './Modal.vue'
import Icon from './Icon.vue'

const ui = useUi()
</script>

<template>
  <Modal
    v-if="ui.confirmState"
    :title="ui.confirmState.title"
    @close="ui.resolveConfirm(false)"
  >
    <div class="cf" :class="{ danger: ui.confirmState.danger }">
      <span class="cf-ic"><Icon :name="ui.confirmState.danger ? 'warn' : 'info'" :size="22" /></span>
      <p class="cf-msg">{{ ui.confirmState.message }}</p>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="ui.resolveConfirm(false)">Cancel</button>
      <button
        class="btn"
        :class="ui.confirmState.danger ? 'btn-danger-solid' : 'btn-primary'"
        @click="ui.resolveConfirm(true)"
      >{{ ui.confirmState.confirmLabel ?? 'Confirm' }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.cf {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  min-width: 400px;
  max-width: 480px;
}
.cf-ic {
  display: inline-flex;
  flex: none;
  color: var(--text-dim);
}
.cf.danger .cf-ic {
  color: var(--danger);
}
.cf-msg {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
  white-space: pre-wrap;
}
.btn-danger-solid {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
  font-weight: 600;
}
.btn-danger-solid:hover {
  filter: brightness(1.08);
}
</style>
