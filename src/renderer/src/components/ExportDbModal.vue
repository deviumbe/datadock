<script setup lang="ts">
import { ref, reactive } from 'vue'
import Modal from './Modal.vue'
import type { DumpFormat, TableDumpMode, TableDumpSpec, TableInfo } from '@shared/types'

const props = defineProps<{ connId: string; tables: TableInfo[] }>()
const emit = defineEmits<{ close: [] }>()

const MODES: { value: TableDumpMode; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'structure', label: 'Structure' },
  { value: 'data', label: 'Data' },
  { value: 'skip', label: 'Skip' }
]

// Default: everything on (both).
const modes = reactive<Record<string, TableDumpMode>>(
  Object.fromEntries(props.tables.map((t) => [keyOf(t), 'both']))
)
const format = ref<DumpFormat>('sql')
const busy = ref(false)
const message = ref('')

function keyOf(t: TableInfo): string {
  return `${t.schema ?? ''}.${t.name}`
}
function setAll(mode: TableDumpMode): void {
  for (const t of props.tables) modes[keyOf(t)] = mode
}

async function run(): Promise<void> {
  busy.value = true
  message.value = ''
  const specs: TableDumpSpec[] = props.tables.map((t) => ({
    schema: t.schema,
    name: t.name,
    mode: modes[keyOf(t)]
  }))
  try {
    const res = await window.api.io.exportDatabase(props.connId, specs, format.value)
    if (!res.canceled) {
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
  <Modal title="Export database" wide @close="emit('close')">
    <div class="top">
      <div class="field">
        <label>Format</label>
        <select class="select" v-model="format">
          <option value="sql">SQL (.sql)</option>
          <option value="sql-zip">Zipped SQL (.zip)</option>
        </select>
      </div>
      <div class="field">
        <label>Set all tables to</label>
        <div class="set-all">
          <button class="btn btn-ghost" @click="setAll('both')">Both</button>
          <button class="btn btn-ghost" @click="setAll('structure')">Structure</button>
          <button class="btn btn-ghost" @click="setAll('data')">Data</button>
          <button class="btn btn-ghost" @click="setAll('skip')">Skip</button>
        </div>
      </div>
    </div>

    <div class="list">
      <div v-for="t in tables" :key="keyOf(t)" class="row" :class="{ off: modes[keyOf(t)] === 'skip' }">
        <span class="tname">{{ t.name }}</span>
        <div class="seg">
          <button
            v-for="m in MODES"
            :key="m.value"
            :class="{ on: modes[keyOf(t)] === m.value, skip: m.value === 'skip' }"
            @click="modes[keyOf(t)] = m.value"
          >
            {{ m.label }}
          </button>
        </div>
      </div>
      <div v-if="tables.length === 0" class="empty">No tables to export.</div>
    </div>

    <div v-if="message" class="msg">{{ message }}</div>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || tables.length === 0" @click="run">
        {{ busy ? 'Exporting…' : 'Export' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.top {
  display: flex;
  gap: 24px;
  margin-bottom: 14px;
}
.set-all {
  display: flex;
  gap: 4px;
}
.set-all .btn {
  padding: 6px 10px;
}
.list {
  max-height: 50vh;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
}
.row:last-child {
  border-bottom: none;
}
.row.off {
  opacity: 0.5;
}
.tname {
  flex: 1;
  font-family: var(--mono);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seg {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.seg button {
  padding: 4px 10px;
  font-size: 11px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
}
.seg button:first-child {
  border-radius: var(--radius-sm) 0 0 var(--radius-sm);
}
.seg button:last-child {
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.seg button.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.seg button.on.skip {
  background: rgba(229, 97, 106, 0.15);
  border-color: var(--danger);
  color: var(--danger);
}
.empty {
  padding: 20px;
  text-align: center;
  color: var(--text-faint);
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
