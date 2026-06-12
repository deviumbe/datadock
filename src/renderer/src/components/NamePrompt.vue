<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Modal from './Modal.vue'

const props = defineProps<{ title: string; initial?: string; submitLabel?: string }>()
const emit = defineEmits<{ submit: [value: string]; close: [] }>()

const value = ref(props.initial ?? '')
const inputEl = ref<HTMLInputElement>()

onMounted(() => inputEl.value?.focus())

function submit(): void {
  if (value.value.trim()) emit('submit', value.value.trim())
}
</script>

<template>
  <Modal :title="title" @close="emit('close')">
    <div class="field">
      <label>Name</label>
      <input
        ref="inputEl"
        class="input"
        v-model="value"
        @keydown.enter="submit"
        @keydown.esc="emit('close')"
        placeholder="Enter a name"
      />
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!value.trim()" @click="submit">
        {{ submitLabel ?? 'Save' }}
      </button>
    </template>
  </Modal>
</template>
