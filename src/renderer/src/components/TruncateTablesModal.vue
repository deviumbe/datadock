<script setup lang="ts">
import { ref } from 'vue'
import Modal from './Modal.vue'
import type { TruncateOptions, DriverType, TableInfo } from '@shared/types'

const props = defineProps<{ tables: TableInfo[]; driver: DriverType }>()
const emit = defineEmits<{ confirm: [opts: TruncateOptions]; close: [] }>()

const ignoreForeignKeys = ref(false)
const restartIdentity = ref(true)
const isPostgresFamily = ['postgres', 'cockroachdb', 'timescaledb', 'redshift'].includes(props.driver)
const mssqlNote = props.driver === 'mssql'
</script>

<template>
  <Modal :title="tables.length > 1 ? `Truncate ${tables.length} tables` : 'Truncate table'" @close="emit('close')">
    <p class="names">{{ tables.map((t) => t.name).join(', ') }}</p>
    <p class="sub">Removes <strong>all rows</strong> but keeps the table and its structure.</p>

    <label class="opt">
      <input type="checkbox" v-model="ignoreForeignKeys" />
      <span>
        Skip foreign-key checks
        <small v-if="isPostgresFamily">— uses <code>CASCADE</code>, which also empties tables that reference these</small>
      </span>
    </label>
    <label class="opt">
      <input type="checkbox" v-model="restartIdentity" />
      <span>Reset auto-increment / identity counters</span>
    </label>

    <p v-if="mssqlNote" class="note">
      SQL Server can't skip FK checks for <code>TRUNCATE</code>; a table referenced by a foreign key
      will error unless those constraints are removed first.
    </p>
    <p class="warn">This cannot be undone.</p>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn drop-go" @click="emit('confirm', { ignoreForeignKeys, restartIdentity })">
        Truncate {{ tables.length > 1 ? `${tables.length} tables` : 'table' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.names {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 6px;
  word-break: break-word;
}
.sub {
  font-size: 12.5px;
  color: var(--text-dim);
  margin-bottom: 12px;
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
.opt small {
  display: block;
  color: var(--text-faint);
  font-size: 11px;
  margin-top: 2px;
}
.opt code,
.note code {
  font-family: var(--mono);
}
.note {
  margin-top: 10px;
  font-size: 11px;
  color: var(--warn);
  line-height: 1.5;
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
