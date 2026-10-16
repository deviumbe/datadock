<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Modal from './Modal.vue'
import { ENVIRONMENT_TEMPLATE } from '@shared/types'

defineProps<{ workspaceName?: string }>()
const emit = defineEmits<{ submit: [name: string, environments: string[]]; close: [] }>()

const name = ref('')
const useTemplate = ref(true)
const inputEl = ref<HTMLInputElement>()

onMounted(() => inputEl.value?.focus())

function submit(): void {
  if (!name.value.trim()) return
  emit('submit', name.value.trim(), useTemplate.value ? [...ENVIRONMENT_TEMPLATE] : [])
}
</script>

<template>
  <Modal title="New Project" @close="emit('close')">
    <div class="field">
      <label>Name</label>
      <input
        ref="inputEl"
        class="input"
        v-model="name"
        @keydown.enter="submit"
        @keydown.esc="emit('close')"
        :placeholder="workspaceName ? `Project in ${workspaceName}` : 'Project name'"
      />
    </div>
    <label class="template">
      <input type="checkbox" v-model="useTemplate" />
      <span>
        Create the standard environments
        <small>{{ ENVIRONMENT_TEMPLATE.join(' · ') }}</small>
      </span>
    </label>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!name.trim()" @click="submit">Create</button>
    </template>
  </Modal>
</template>

<style scoped>
.template {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  cursor: pointer;
  font-size: 13px;
}
.template input {
  margin-top: 2px;
}
.template small {
  display: block;
  color: var(--text-faint);
  font-size: 11.5px;
  margin-top: 2px;
}
</style>
