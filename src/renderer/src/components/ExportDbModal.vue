<script setup lang="ts">
import { ref, reactive, computed, shallowRef, onMounted } from 'vue'
import Modal from './Modal.vue'
import AnonymizeStep from './AnonymizeStep.vue'
import { useTasks } from '../stores/tasks'
import { useWorkspace } from '../stores/workspace'
import { sqlDialect, type DumpFormat, type TableDumpMode, type TableDumpSpec, type TableInfo } from '@shared/types'
import { countMasked, type MaskConfig } from '@shared/mask'

const props = defineProps<{ connId: string; tables: TableInfo[] }>()
const emit = defineEmits<{ close: [] }>()

const tasks = useTasks()
const ws = useWorkspace()
const driver = computed(() => ws.findConnection(props.connId)?.driver ?? '')

const MODES: { value: TableDumpMode; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'structure', label: 'Structure' },
  { value: 'data', label: 'Data' },
  { value: 'skip', label: 'Skip' }
]

const step = ref<'tables' | 'mask'>('tables')
const modes = reactive<Record<string, TableDumpMode>>(
  Object.fromEntries(props.tables.map((t) => [keyOf(t), 'both']))
)
const format = ref<DumpFormat>('sql')
const addDrops = ref(true)

// shallowRef: keep the emitted config a plain object so it stays
// structured-cloneable across IPC (a deep ref would wrap it in a Proxy).
const maskConfig = shallowRef<MaskConfig | undefined>()
const maskedCount = computed(() => countMasked(maskConfig.value))

// Which engine does the work: native CLI when present + unmasked, else built-in.
const nativeAvail = ref(false)
const nativeTool = computed(() => (sqlDialect(driver.value) === 'postgres' ? 'pg_dump' : 'mysqldump'))
const usingNative = computed(() => nativeAvail.value && maskedCount.value === 0)
onMounted(async () => {
  nativeAvail.value = await window.api.io.nativeAvailable(driver.value).catch(() => false)
})

function keyOf(t: TableInfo): string {
  return `${t.schema ?? ''}.${t.name}`
}
function setAll(mode: TableDumpMode): void {
  for (const t of props.tables) modes[keyOf(t)] = mode
}

// Tables whose data is being exported — the only ones worth anonymizing.
const dataTables = computed(() =>
  props.tables.filter((t) => modes[keyOf(t)] === 'data' || modes[keyOf(t)] === 'both')
)

function run(): void {
  const specs: TableDumpSpec[] = props.tables.map((t) => ({
    schema: t.schema,
    name: t.name,
    mode: modes[keyOf(t)]
  }))
  const fmt = format.value
  const mask = maskConfig.value

  // The OS save dialog opens immediately (in main); once a path is chosen the
  // dump runs in the background via the task tray. Dismiss the modal now.
  tasks.start({
    kind: 'export',
    title: `Export ${props.tables.length} table(s)`,
    run: async (opId) => {
      const res = await window.api.io.exportDatabase(props.connId, specs, fmt, mask, addDrops.value, opId)
      if (res.canceled) return { canceled: true }
      return { message: `Saved to ${res.path}` }
    }
  })
  emit('close')
}
</script>

<template>
  <Modal title="Export database" wide @close="emit('close')">
    <div class="steps">
      <span class="stp" :class="{ on: step === 'tables' }">1 · Tables</span>
      <span class="sarrow">→</span>
      <span class="stp" :class="{ on: step === 'mask' }">2 · Anonymize</span>
    </div>

    <!-- STEP 1: tables -->
    <template v-if="step === 'tables'">
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

      <label class="opt">
        <input type="checkbox" v-model="addDrops" />
        Add <code>DROP TABLE IF EXISTS</code> before each table (restorable, phpMyAdmin-style)
      </label>

      <div class="engine">
        <template v-if="usingNative">Using native <code>{{ nativeTool }}</code></template>
        <template v-else-if="maskedCount">Using built-in dumper (required for anonymization)</template>
        <template v-else>Using built-in dumper (<code>{{ nativeTool }}</code> not found on PATH)</template>
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
            >{{ m.label }}</button>
          </div>
        </div>
        <div v-if="tables.length === 0" class="empty">No tables to export.</div>
      </div>
    </template>

    <!-- STEP 2: masking -->
    <AnonymizeStep v-else :conn-id="connId" :data-tables="dataTables" v-model="maskConfig" />

    <template #footer>
      <template v-if="step === 'tables'">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="tables.length === 0" @click="step = 'mask'">Next: anonymize →</button>
      </template>
      <template v-else>
        <button class="btn" @click="step = 'tables'">← Back</button>
        <button class="btn btn-primary" @click="run">
          {{ maskedCount ? `Export (${maskedCount} masked)` : 'Export' }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.steps {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  font-size: 12px;
}
.stp {
  color: var(--text-faint);
  font-weight: 600;
}
.stp.on {
  color: var(--accent);
}
.sarrow {
  color: var(--text-faint);
}
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
.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12.5px;
  color: var(--text-dim);
  cursor: pointer;
}
.opt code,
.engine code {
  font-family: var(--mono);
  font-size: 11px;
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
}
.engine {
  margin-bottom: 12px;
  font-size: 11.5px;
  color: var(--text-faint);
}
</style>
