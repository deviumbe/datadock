<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Modal from './Modal.vue'

const props = defineProps<{ names: string[] }>()
const emit = defineEmits<{ submit: [values: Record<string, string>]; close: [] }>()

const values = ref<Record<string, string>>(Object.fromEntries(props.names.map((n) => [n, ''])))
const first = ref<HTMLInputElement>()

onMounted(() => first.value?.focus())

function submit(): void {
  emit('submit', { ...values.value })
}
</script>

<template>
  <Modal title="Query variables" @close="emit('close')">
    <p class="lead">Fill in the values to substitute before running. Values are inserted as plain text — add quotes in your query for string literals.</p>
    <div class="vars">
      <div v-for="(name, i) in names" :key="name" class="field">
        <label>{{ name }}</label>
        <input
          :ref="i === 0 ? (el) => (first = el as HTMLInputElement) : undefined"
          class="input"
          v-model="values[name]"
          :placeholder="`{{ ${name} }}`"
          @keydown.enter="submit"
        />
      </div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="submit">Run</button>
    </template>
  </Modal>
</template>

<style scoped>
.lead {
  color: var(--text-dim);
  font-size: 12.5px;
  margin-bottom: 16px;
  line-height: 1.5;
}
.vars {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
