<script setup lang="ts">
import { ref, reactive, computed, shallowRef, onMounted } from 'vue'
import Modal from './Modal.vue'
import AnonymizeStep from './AnonymizeStep.vue'
import { useWorkspace } from '../stores/workspace'
import { useTasks } from '../stores/tasks'
import { isSqlDriver, sqlDialect } from '@shared/types'
import type { TableDumpMode, TableDumpSpec, TableInfo, TransferMode } from '@shared/types'
import { countMasked, type MaskConfig } from '@shared/mask'

const props = defineProps<{ connId: string; tables: TableInfo[] }>()
const emit = defineEmits<{ close: []; done: [] }>()

const ws = useWorkspace()
const tasks = useTasks()

const MODES: { value: TableDumpMode; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'structure', label: 'Structure' },
  { value: 'data', label: 'Data' },
  { value: 'skip', label: 'Skip' }
]

const step = ref<'setup' | 'mask'>('setup')
const anonymize = ref(false)

const source = computed(() => ws.findConnection(props.connId))

// Which engine does the work: native CLI when present + unmasked, else built-in.
const nativeAvail = ref(false)
const nativeTool = computed(() => (sqlDialect(source.value?.driver ?? '') === 'postgres' ? 'pg_dump' : 'mysqldump'))
const usingNative = computed(() => nativeAvail.value && !anonymize.value)
onMounted(async () => {
  nativeAvail.value = await window.api.io.nativeAvailable(source.value?.driver ?? '').catch(() => false)
})

type TargetOption = { id: string; name: string; driver: string; path: string; production?: boolean; readOnly?: boolean }

const targets = computed<TargetOption[]>(() => {
  const src = source.value
  if (!src || !isSqlDriver(src.driver)) return []
  const dialect = sqlDialect(src.driver)
  const out: TargetOption[] = []
  for (const p of ws.projects)
    for (const e of p.environments)
      for (const c of e.connections) {
        if (c.id === props.connId) continue
        if (!isSqlDriver(c.driver) || sqlDialect(c.driver) !== dialect) continue
        out.push({
          id: c.id,
          name: c.name,
          driver: c.driver,
          path: `${p.name} / ${e.name}`,
          production: c.production,
          readOnly: c.readOnly
        })
      }
  return out
})

const targetId = ref('')
const target = computed(() => targets.value.find((t) => t.id === targetId.value))

const mode = ref<TransferMode>('replace')

const modes = reactive<Record<string, TableDumpMode>>(
  Object.fromEntries(props.tables.map((t) => [keyOf(t), 'both']))
)

const confirmProd = ref(false)

// shallowRef: keep the emitted config a plain object so it stays
// structured-cloneable across IPC (a deep ref would wrap it in a Proxy).
const maskConfig = shallowRef<MaskConfig | undefined>()
const maskedCount = computed(() => countMasked(maskConfig.value))
const runLabel = computed(() => (mode.value === 'replace' ? 'Replace & clone' : 'Clone'))

function keyOf(t: TableInfo): string {
  return `${t.schema ?? ''}.${t.name}`
}
function setAll(m: TableDumpMode): void {
  for (const t of props.tables) modes[keyOf(t)] = m
}

const activeCount = computed(() => props.tables.filter((t) => modes[keyOf(t)] !== 'skip').length)

// Tables whose data is transferred — the only ones worth anonymizing.
const dataTables = computed(() =>
  props.tables.filter((t) => modes[keyOf(t)] === 'data' || modes[keyOf(t)] === 'both')
)

const blocked = computed(() => {
  if (!target.value) return 'Choose a target connection.'
  if (target.value.readOnly) return 'Target is read-only — transfer is disabled.'
  if (activeCount.value === 0) return 'All tables are set to skip.'
  if (target.value.production && !confirmProd.value)
    return 'Target is a production connection — confirm below to proceed.'
  return ''
})

function run(): void {
  if (blocked.value || !target.value) return
  const tgt = target.value
  const specs: TableDumpSpec[] = props.tables.map((t) => ({
    schema: t.schema,
    name: t.name,
    mode: modes[keyOf(t)]
  }))
  const mask = anonymize.value ? maskConfig.value : undefined
  const m = mode.value

  // Launch in the background (tracked by the task tray) and dismiss the dialog
  // immediately — the rest of the app stays usable while it runs.
  tasks.start({
    kind: 'transfer',
    title: `Clone ${source.value?.name ?? ''} → ${tgt.name}`,
    run: async (opId) => {
      if (ws.connStates[tgt.id] !== 'connected') await window.api.db.connect(tgt.id)
      const res = await window.api.io.transferDatabase(props.connId, tgt.id, specs, m, mask, opId)
      void ws.refreshTables(tgt.id)
      return {
        message: res.errors.length
          ? `Cloned ${res.tableCount} table(s) into ${tgt.name} — ${res.errors.length} error(s)`
          : `Cloned ${res.tableCount} table(s) into ${tgt.name}`,
        errors: res.errors
      }
    }
  })
  emit('close')
}
</script>

<template>
  <Modal title="Clone database" wide @close="emit('close')">
    <p v-if="step === 'setup'" class="intro">
      Copy this database's structure and data into another connection. The source is
      only read — it is never modified.
    </p>
    <div v-if="anonymize" class="steps">
      <span class="stp" :class="{ on: step === 'setup' }">1 · Setup</span>
      <span class="sarrow">→</span>
      <span class="stp" :class="{ on: step === 'mask' }">2 · Anonymize</span>
    </div>

    <!-- STEP 2: anonymize -->
    <AnonymizeStep
      v-if="step === 'mask'"
      :conn-id="connId"
      :data-tables="dataTables"
      v-model="maskConfig"
    />

    <!-- STEP 1: setup -->
    <template v-else>
    <div class="route">
      <div class="end">
        <span class="lbl">Source</span>
        <span class="cval">{{ source?.name }}</span>
        <span class="cdrv">{{ source?.driver }}</span>
      </div>
      <span class="arrow">→</span>
      <div class="end">
        <span class="lbl">Target</span>
        <select v-if="targets.length" class="select" v-model="targetId">
          <option value="" disabled>Select a connection…</option>
          <option v-for="t in targets" :key="t.id" :value="t.id">
            {{ t.name }} · {{ t.path }}{{ t.production ? ' (production)' : '' }}{{ t.readOnly ? ' (read-only)' : '' }}
          </option>
        </select>
        <span v-else class="none">No compatible {{ source ? sqlDialect(source.driver) : '' }} connections</span>
      </div>
    </div>

    <div class="modes">
      <div class="seg">
        <button :class="{ on: mode === 'replace' }" @click="mode = 'replace'">Replace</button>
        <button :class="{ on: mode === 'merge' }" @click="mode = 'merge'">Merge</button>
      </div>
      <p class="hint">
        <template v-if="mode === 'replace'">
          Existing tables on the target are <strong>dropped</strong> and recreated from the source — a clean restore.
        </template>
        <template v-else>
          The source dump runs over the target as-is; existing tables are kept (no drop).
        </template>
      </p>
    </div>

    <div v-if="target?.production" class="prod">
      <label>
        <input type="checkbox" v-model="confirmProd" />
        I understand <strong>{{ target.name }}</strong> is a production database and want to overwrite it.
      </label>
    </div>

    <div class="top">
      <label>Set all tables to</label>
      <div class="set-all">
        <button class="btn btn-ghost" @click="setAll('both')">Both</button>
        <button class="btn btn-ghost" @click="setAll('structure')">Structure</button>
        <button class="btn btn-ghost" @click="setAll('data')">Data</button>
        <button class="btn btn-ghost" @click="setAll('skip')">Skip</button>
      </div>
    </div>

    <div class="list">
      <div v-for="t in tables" :key="keyOf(t)" class="row" :class="{ off: modes[keyOf(t)] === 'skip' }">
        <span class="tname">{{ t.name }}</span>
        <div class="seg seg-sm">
          <button
            v-for="m in MODES"
            :key="m.value"
            :class="{ on: modes[keyOf(t)] === m.value, skip: m.value === 'skip' }"
            @click="modes[keyOf(t)] = m.value"
          >{{ m.label }}</button>
        </div>
      </div>
      <div v-if="tables.length === 0" class="empty">No tables to transfer.</div>
    </div>

    <label class="anon">
      <input type="checkbox" v-model="anonymize" />
      Anonymize sensitive columns (replace with fake data before transferring)
    </label>

    <div class="engine">
      <template v-if="usingNative">Using native <code>{{ nativeTool }}</code> → fast, handles any size</template>
      <template v-else-if="anonymize">Using built-in engine (required for anonymization)</template>
      <template v-else>Using built-in engine (<code>{{ nativeTool }}</code> not found on PATH)</template>
    </div>
    </template>

    <template #footer>
      <template v-if="step === 'mask'">
        <button class="btn" @click="step = 'setup'">← Back</button>
        <button class="btn btn-primary" :disabled="!!blocked" :title="blocked" @click="run">
          {{ maskedCount ? `${runLabel} (${maskedCount} masked)` : runLabel }}
        </button>
      </template>
      <template v-else>
        <button class="btn" @click="emit('close')">Cancel</button>
        <button
          v-if="anonymize"
          class="btn btn-primary"
          :disabled="!!blocked"
          :title="blocked"
          @click="step = 'mask'"
        >Next: anonymize →</button>
        <button v-else class="btn btn-primary" :disabled="!!blocked" :title="blocked" @click="run">
          {{ runLabel }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.intro {
  margin: 0 0 16px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-dim);
}
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
.anon {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  font-size: 12.5px;
  color: var(--text-dim);
  cursor: pointer;
}
.engine {
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--text-faint);
}
.engine code {
  font-family: var(--mono);
  font-size: 11px;
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
}
.route {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 16px;
}
.end {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
  min-width: 0;
}
.lbl {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cval {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text);
}
.cdrv {
  font-size: 11px;
  color: var(--text-faint);
}
.arrow {
  color: var(--accent);
  font-size: 18px;
  padding-bottom: 4px;
}
.none {
  font-size: 12px;
  color: var(--text-faint);
  padding: 7px 0;
}
.modes {
  margin-bottom: 14px;
}
.seg {
  display: flex;
  gap: 4px;
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
.hint {
  margin: 8px 2px 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
}
.hint strong {
  color: var(--text);
}
.prod {
  margin-bottom: 14px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: rgba(229, 97, 106, 0.12);
  border: 1px solid var(--danger);
  font-size: 12px;
  color: var(--text);
}
.prod label {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  cursor: pointer;
}
.top {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.top label {
  font-size: 12px;
  color: var(--text-dim);
}
.set-all {
  display: flex;
  gap: 4px;
}
.set-all .btn {
  padding: 6px 10px;
}
.list {
  max-height: 42vh;
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
.seg-sm {
  flex: none;
  gap: 2px;
}
.seg-sm button {
  flex: none;
  padding: 4px 10px;
  font-size: 11px;
  border-color: var(--border-strong);
}
.seg-sm button:first-child {
  border-radius: var(--radius-sm) 0 0 var(--radius-sm);
}
.seg-sm button:last-child {
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.seg-sm button.on.skip {
  background: rgba(229, 97, 106, 0.15);
  border-color: var(--danger);
  color: var(--danger);
}
.empty {
  padding: 20px;
  text-align: center;
  color: var(--text-faint);
}
</style>
