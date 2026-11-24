<script setup lang="ts">
import { ref, useId } from 'vue'
import Modal from './Modal.vue'
import type { ColumnMeta } from '@shared/types'

const uid = useId()

const props = defineProps<{ columns: ColumnMeta[]; rowCount: number }>()
const emit = defineEmits<{ apply: [column: string, value: unknown]; close: [] }>()

const column = ref(props.columns[0]?.name ?? '')
const value = ref('')
const setNull = ref(false)

function apply(): void {
  if (!column.value) return
  emit('apply', column.value, setNull.value ? null : value.value)
}
</script>

<template>
  <Modal title="Bulk edit selected rows" @close="emit('close')">
    <p class="lead">
      Set one column to the same value across the
      <strong>{{ rowCount }}</strong> selected row{{ rowCount === 1 ? '' : 's' }}. The change is
      staged as a pending edit — review it in the grid and commit with ⌘S.
    </p>
    <div class="field">
      <label :for="`${uid}-column`">Column</label>
      <select :id="`${uid}-column`" class="select" v-model="column">
        <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
      </select>
    </div>
    <div class="field">
      <label :for="`${uid}-new-value`">New value</label>
      <input :id="`${uid}-new-value`"
        class="input"
        v-model="value"
        :disabled="setNull"
        placeholder="value to set"
        @keydown.enter="apply"
      />
    </div>
    <label class="check">
      <input type="checkbox" v-model="setNull" />
      <span>Set to NULL</span>
    </label>
    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!column" @click="apply">
        Apply to {{ rowCount }} row{{ rowCount === 1 ? '' : 's' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.lead {
  color: var(--text-dim);
  font-size: var(--fs-base);
  margin-bottom: 16px;
  line-height: 1.5;
}
.field {
  margin-bottom: 14px;
}
.field label {
  display: block;
  margin-bottom: 5px;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
  font-size: var(--fs-base);
}
</style>
