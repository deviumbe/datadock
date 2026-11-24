<script setup lang="ts">
import { useId } from 'vue'
import { useUi } from '../stores/ui'
import Modal from './Modal.vue'
import Icon from './Icon.vue'

const ui = useUi()
const messageId = useId()
</script>

<template>
  <Modal
    v-if="ui.confirmState"
    :title="ui.confirmState.title"
    alert
    :describedby="messageId"
    @close="ui.resolveConfirm(false)"
  >
    <div class="cf" :class="{ danger: ui.confirmState.danger }">
      <span class="cf-ic"><Icon :name="ui.confirmState.danger ? 'warn' : 'info'" :size="22" /></span>
      <p :id="messageId" class="cf-msg">{{ ui.confirmState.message }}</p>
    </div>
    <template #footer>
      <button class="btn btn-ghost" :data-autofocus="ui.confirmState.danger ? '' : undefined" @click="ui.resolveConfirm(false)">Cancel</button>
      <button
        class="btn"
        :data-autofocus="ui.confirmState.danger ? undefined : ''"
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
}
.cf-ic {
  display: inline-flex;
  flex: none;
  color: var(--text-dim);
}
.cf.danger .cf-ic {
  color: var(--danger-text);
}
.cf-msg {
  font-size: var(--fs-base);
  line-height: 1.55;
  color: var(--text);
  white-space: pre-wrap;
}
.btn-danger-solid {
  background: var(--danger);
  border-color: var(--danger);
  color: var(--on-danger);
  font-weight: 600;
}
.btn-danger-solid:hover {
  background: var(--danger-hover);
  border-color: var(--danger-hover);
}
</style>
