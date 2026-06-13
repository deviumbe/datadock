<script setup lang="ts">
import { ref } from 'vue'
import Modal from './Modal.vue'
import type { DropTableOptions, DriverType, TableInfo } from '@shared/types'

const props = defineProps<{ tables: TableInfo[]; driver: DriverType }>()
const emit = defineEmits<{ confirm: [opts: DropTableOptions]; close: [] }>()

const ignoreForeignKeys = ref(false)
const cascade = ref(false)
const mssqlNote = props.driver === 'mssql'
</script>

<template>
  <Modal :title="tables.length > 1 ? `Drop ${tables.length} tables` : 'Drop table'" @close="emit('close')">
    <p class="names">{{ tables.map((t) => t.name).join(', ') }}</p>

    <label class="opt">
      <input type="checkbox" v-model="ignoreForeignKeys" />
      <span>Ignore foreign-key checks</span>
    </label>
    <label class="opt">
      <input type="checkbox" v-model="cascade" />
      <span>Cascade — also drop dependent objects / rows linked by foreign keys</span>
    </label>

    <p v-if="mssqlNote" class="note">
      SQL Server doesn't support these options for <code>DROP TABLE</code>; a referenced table will
      error unless its foreign keys are removed first.
    </p>
    <p class="warn">This cannot be undone.</p>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button
        class="btn drop-go"
        @click="emit('confirm', { ignoreForeignKeys, cascade })"
      >
        Drop {{ tables.length > 1 ? `${tables.length} tables` : 'table' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.names {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 14px;
  word-break: break-word;
}
.opt {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 0;
  font-size: 13px;
  color: var(--text);
}
.opt input {
  margin-top: 2px;
}
.note {
  margin-top: 10px;
  font-size: 11px;
  color: var(--warn);
  line-height: 1.5;
}
.note code {
  font-family: var(--mono);
}
.warn {
  margin-top: 12px;
  font-size: 12px;
  color: var(--danger);
}
.drop-go {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
  font-weight: 600;
}
.drop-go:hover {
  background: #d6535c;
}
</style>
