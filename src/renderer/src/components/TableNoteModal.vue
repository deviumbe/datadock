<script setup lang="ts">
import { ref } from 'vue'
import Modal from './Modal.vue'
import Icon from './Icon.vue'

const props = defineProps<{ table: string; initial: string }>()
const emit = defineEmits<{ save: [text: string]; close: [] }>()

const text = ref(props.initial)

function save(): void {
  emit('save', text.value)
}
</script>

<template>
  <Modal :title="`Note · ${table}`" @close="emit('close')">
    <div class="nt">
      <p class="hint">
        <Icon name="note" :size="13" /> A private note about this table — what it's for, gotchas,
        anything worth remembering. Stored locally on this machine only.
      </p>
      <textarea
        v-model="text"
        class="input area"
        rows="6"
        placeholder="e.g. Soft-deletes via deleted_at — filter it out in most queries."
        @keydown.meta.enter="save"
        @keydown.ctrl.enter="save"
      ></textarea>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="save">Save note</button>
    </template>
  </Modal>
</template>

<style scoped>
.nt {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 440px;
}
.hint {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
}
.hint :deep(.dd-icon) {
  margin-top: 1px;
  flex: none;
  color: var(--accent);
}
.area {
  width: 100%;
  resize: vertical;
  font-family: var(--font);
  line-height: 1.55;
}
</style>
