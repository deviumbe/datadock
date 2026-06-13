<script setup lang="ts">
import { ref } from 'vue'
import Modal from './Modal.vue'
import type { ColumnMeta, ExportFormat, TableInfo } from '@shared/types'

const props = defineProps<{
  connId: string
  columns?: ColumnMeta[] // current in-memory result (for "current page")
  rows?: unknown[][]
  tableName?: string
  table?: TableInfo // present for tables -> enables "entire table" scope
}>()
const emit = defineEmits<{ close: [] }>()

// "Current page" needs an in-memory result; "Entire table" needs a table.
const hasPage = !!props.rows
const hasTable = !!props.table

const FORMATS: { value: ExportFormat; label: string; hint: string }[] = [
  { value: 'csv', label: 'CSV', hint: 'Comma-separated values' },
  { value: 'xlsx', label: 'Excel', hint: '.xlsx workbook' },
  { value: 'json', label: 'JSON', hint: 'Array of row objects' },
  { value: 'sql', label: 'SQL', hint: 'INSERT statements' }
]

const format = ref<ExportFormat>('csv')
const scope = ref<'page' | 'all'>(hasTable && !hasPage ? 'all' : hasTable ? 'all' : 'page')
const busy = ref(false)
const message = ref('')

async function run(): Promise<void> {
  busy.value = true
  message.value = ''
  try {
    const res =
      scope.value === 'all' && props.table
        ? await window.api.io.exportTable(props.connId, props.table, format.value)
        : await window.api.io.exportData(props.connId, format.value, {
            columns: (props.columns ?? []).map((c) => ({ name: c.name })),
            rows: props.rows ?? [],
            tableName: props.tableName
          })
    if (res.canceled) message.value = ''
    else {
      message.value = `Saved to ${res.path}`
      setTimeout(() => emit('close'), 900)
    }
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="Export" @close="emit('close')">
    <div v-if="hasTable && hasPage" class="seg-row">
      <label>Scope</label>
      <div class="seg">
        <button :class="{ on: scope === 'all' }" @click="scope = 'all'">Entire table</button>
        <button :class="{ on: scope === 'page' }" @click="scope = 'page'">Current page</button>
      </div>
    </div>
    <div v-else class="seg-row">
      <label>Scope</label>
      <span class="hint">{{ hasTable ? 'Entire table' : `Current result (${rows?.length ?? 0} rows)` }}</span>
    </div>

    <div class="field" style="margin-top: 14px">
      <label>Format</label>
      <div class="formats">
        <button
          v-for="f in FORMATS"
          :key="f.value"
          class="fmt"
          :class="{ on: format === f.value }"
          @click="format = f.value"
        >
          <strong>{{ f.label }}</strong>
          <span>{{ f.hint }}</span>
        </button>
      </div>
    </div>

    <div v-if="message" class="msg">{{ message }}</div>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy" @click="run">
        {{ busy ? 'Exporting…' : 'Export' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.seg-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.seg-row label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  width: 60px;
}
.seg {
  display: flex;
  gap: 4px;
}
.seg button {
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
}
.seg button.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.hint {
  color: var(--text-faint);
  font-size: 12px;
}
.formats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.fmt {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  text-align: left;
}
.fmt span {
  font-size: 11px;
  color: var(--text-faint);
}
.fmt.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.fmt.on strong {
  color: var(--accent);
}
.msg {
  margin-top: 12px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 12px;
  word-break: break-all;
}
</style>
