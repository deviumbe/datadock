<script setup lang="ts">
import { ref } from 'vue'
import Modal from './Modal.vue'
import type { TableInfo } from '@shared/types'

const props = defineProps<{ connId: string; tables: TableInfo[] }>()
const emit = defineEmits<{ close: []; done: [] }>()

const mode = ref<'sql' | 'csv'>('sql')
const targetTable = ref(props.tables[0]?.name ?? '')
const busy = ref(false)
const message = ref('')
const errors = ref<string[]>([])

function tableByName(name: string): TableInfo | undefined {
  return props.tables.find((t) => t.name === name)
}

async function runSql(): Promise<void> {
  busy.value = true
  message.value = ''
  errors.value = []
  try {
    const res = await window.api.io.importSql(props.connId)
    if (res.canceled) return
    message.value = `Executed ${res.statements ?? 0} statement(s).`
    errors.value = res.errors
    emit('done')
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function runCsv(): Promise<void> {
  const table = tableByName(targetTable.value)
  if (!table) return
  busy.value = true
  message.value = ''
  errors.value = []
  try {
    const res = await window.api.io.importCsv(props.connId, {
      schema: table.schema,
      name: table.name,
      type: table.type
    })
    if (res.canceled) return
    message.value = `Inserted ${res.rowsInserted ?? 0} row(s) into ${table.name}.`
    errors.value = res.errors
    emit('done')
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="Import" @close="emit('close')">
    <div class="seg">
      <button :class="{ on: mode === 'sql' }" @click="mode = 'sql'">SQL script</button>
      <button :class="{ on: mode === 'csv' }" @click="mode = 'csv'">CSV → table</button>
    </div>

    <div v-if="mode === 'sql'" class="pane">
      <p class="desc">Choose a <code>.sql</code> file. Statements run in order against the connected database.</p>
      <button class="btn btn-primary" :disabled="busy" @click="runSql">
        {{ busy ? 'Running…' : 'Choose file & run' }}
      </button>
    </div>

    <div v-else class="pane">
      <p class="desc">Insert rows from a <code>.csv</code> (with a header row) into a table.</p>
      <div class="field">
        <label>Target table</label>
        <select class="select" v-model="targetTable">
          <option v-for="t in tables" :key="t.name" :value="t.name">{{ t.name }}</option>
        </select>
      </div>
      <button class="btn btn-primary" :disabled="busy || !targetTable" @click="runCsv" style="margin-top: 12px">
        {{ busy ? 'Importing…' : 'Choose file & import' }}
      </button>
    </div>

    <div v-if="message" class="msg">{{ message }}</div>
    <div v-if="errors.length" class="errors">
      <strong>{{ errors.length }} error(s):</strong>
      <div v-for="(e, i) in errors.slice(0, 20)" :key="i" class="err">{{ e }}</div>
    </div>

    <template #footer>
      <button class="btn" @click="emit('close')">Close</button>
    </template>
  </Modal>
</template>

<style scoped>
.seg {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
}
.seg button {
  flex: 1;
  padding: 8px;
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
.pane {
  display: flex;
  flex-direction: column;
}
.desc {
  color: var(--text-dim);
  font-size: 12px;
  margin-bottom: 14px;
  line-height: 1.5;
}
.desc code {
  font-family: var(--mono);
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
}
.msg {
  margin-top: 14px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  background: rgba(63, 207, 142, 0.13);
  color: var(--ok);
  font-size: 12px;
}
.errors {
  margin-top: 12px;
  max-height: 180px;
  overflow-y: auto;
  font-size: 11px;
  color: var(--danger);
}
.err {
  font-family: var(--mono);
  padding: 3px 0;
  word-break: break-word;
}
</style>
