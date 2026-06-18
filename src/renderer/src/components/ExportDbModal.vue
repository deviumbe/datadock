<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import Modal from './Modal.vue'
import type { DumpFormat, TableDumpMode, TableDumpSpec, TableInfo, SchemaTable } from '@shared/types'
import { MASK_OPTIONS, guessMask, type MaskType, type MaskConfig, type MaskOption } from '@shared/mask'

const props = defineProps<{ connId: string; tables: TableInfo[] }>()
const emit = defineEmits<{ close: [] }>()

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
const busy = ref(false)
const message = ref('')

// masking
const schema = ref<SchemaTable[]>([])
const schemaLoaded = ref(false)
const masks = reactive<Record<string, Record<string, MaskType>>>({})
const expanded = reactive<Set<string>>(new Set())

const maskGroups = computed(() => {
  const g: Record<string, MaskOption[]> = {}
  for (const o of MASK_OPTIONS) if (o.value !== 'none') (g[o.group] ??= []).push(o)
  return g
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
function columnsFor(name: string): SchemaTable['columns'] {
  return schema.value.find((s) => s.name === name)?.columns ?? []
}
const maskedCount = computed(() => {
  let n = 0
  for (const t of dataTables.value) {
    const m = masks[t.name]
    if (m) for (const c of columnsFor(t.name)) if (m[c.name] && m[c.name] !== 'none') n++
  }
  return n
})
function tableMaskedCount(name: string): number {
  const m = masks[name]
  return m ? columnsFor(name).filter((c) => m[c.name] && m[c.name] !== 'none').length : 0
}

async function ensureSchema(): Promise<void> {
  if (schemaLoaded.value) return
  schema.value = await window.api.db.schemaSnapshot(props.connId).catch(() => [])
  schemaLoaded.value = true
  applyGuesses()
  // expand tables that have a guessed mask, so the relevant ones show first
  for (const t of dataTables.value) if (tableMaskedCount(t.name) > 0) expanded.add(t.name)
}
function applyGuesses(): void {
  for (const t of schema.value) {
    const m = (masks[t.name] ??= {})
    for (const c of t.columns) m[c.name] = guessMask(c.name, c.type)
  }
}
function clearAll(): void {
  for (const t of schema.value) {
    const m = (masks[t.name] ??= {})
    for (const c of t.columns) m[c.name] = 'none'
  }
}
function toggle(name: string): void {
  expanded.has(name) ? expanded.delete(name) : expanded.add(name)
}

async function goMask(): Promise<void> {
  await ensureSchema()
  step.value = 'mask'
}

function buildMaskConfig(): MaskConfig | undefined {
  const cfg: MaskConfig = {}
  for (const t of dataTables.value) {
    const m = masks[t.name]
    if (!m) continue
    const cols: Record<string, MaskType> = {}
    for (const c of columnsFor(t.name)) if (m[c.name] && m[c.name] !== 'none') cols[c.name] = m[c.name]
    if (Object.keys(cols).length) cfg[t.name] = cols
  }
  return Object.keys(cfg).length ? cfg : undefined
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
    const res = await window.api.io.exportDatabase(props.connId, specs, format.value, buildMaskConfig())
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

onMounted(() => {
  /* schema loads lazily when entering the masking step */
})
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
    <template v-else>
      <div class="mask-intro">
        <div>
          <strong>🎭 Data masking</strong> — replace sensitive columns with realistic fake data so you can safely copy production into a local database.
          <div class="msum">
            <b>{{ maskedCount }}</b> column{{ maskedCount === 1 ? '' : 's' }} across
            <b>{{ dataTables.length }}</b> table{{ dataTables.length === 1 ? '' : 's' }} will be anonymized.
          </div>
        </div>
        <div class="mask-actions">
          <button class="btn btn-ghost" @click="applyGuesses">Smart guesses</button>
          <button class="btn btn-ghost" @click="clearAll">Clear all</button>
        </div>
      </div>

      <div v-if="!schemaLoaded" class="empty">Loading columns…</div>
      <div v-else-if="!dataTables.length" class="empty">No table is exporting data — nothing to anonymize.</div>
      <div v-else class="mlist">
        <div v-for="t in dataTables" :key="t.name" class="mtable">
          <button class="mhead" @click="toggle(t.name)">
            <span class="caret" :class="{ open: expanded.has(t.name) }">▸</span>
            <span class="mtname">{{ t.name }}</span>
            <span v-if="tableMaskedCount(t.name)" class="mbadge">🎭 {{ tableMaskedCount(t.name) }}</span>
            <span class="mcount">{{ columnsFor(t.name).length }} cols</span>
          </button>
          <div v-if="expanded.has(t.name)" class="mcols">
            <div v-for="c in columnsFor(t.name)" :key="c.name" class="mcol" :class="{ masked: masks[t.name]?.[c.name] && masks[t.name][c.name] !== 'none' }">
              <span class="mcname">{{ c.name }}<span v-if="c.isPrimaryKey" class="pk">PK</span></span>
              <span class="mctype">{{ c.type }}</span>
              <select class="select msel" v-model="masks[t.name][c.name]">
                <option value="none">— Keep original —</option>
                <optgroup v-for="(opts, grp) in maskGroups" :key="grp" :label="grp">
                  <option v-for="o in opts" :key="o.value" :value="o.value">{{ o.label }}</option>
                </optgroup>
              </select>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-if="message" class="msg">{{ message }}</div>

    <template #footer>
      <template v-if="step === 'tables'">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="tables.length === 0" @click="goMask">Next: anonymize →</button>
      </template>
      <template v-else>
        <button class="btn" @click="step = 'tables'">← Back</button>
        <button class="btn btn-primary" :disabled="busy" @click="run">
          {{ busy ? 'Exporting…' : maskedCount ? `Export (${maskedCount} masked)` : 'Export' }}
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
.msg {
  margin-top: 12px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 12px;
  word-break: break-all;
}
/* masking step */
.mask-intro {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 12px;
  font-size: 12.5px;
  color: var(--text-dim);
}
.mask-intro strong {
  color: var(--text);
}
.msum {
  margin-top: 6px;
  font-size: 12px;
}
.msum b {
  color: var(--accent);
}
.mask-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
  flex: none;
}
.mlist {
  max-height: 48vh;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.mtable {
  border-bottom: 1px solid var(--border);
}
.mtable:last-child {
  border-bottom: none;
}
.mhead {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  font-size: 12.5px;
  color: var(--text);
}
.mhead:hover {
  background: var(--bg-hover);
}
.caret {
  color: var(--text-faint);
  display: inline-block;
  transition: transform 0.12s ease;
}
.caret.open {
  transform: rotate(90deg);
}
.mtname {
  font-family: var(--mono);
  font-weight: 600;
}
.mbadge {
  font-size: 10px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 999px;
  padding: 1px 7px;
  font-weight: 600;
}
.mcount {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-faint);
}
.mcols {
  border-top: 1px solid var(--border);
  background: var(--bg-app);
}
.mcol {
  display: grid;
  grid-template-columns: 1fr 110px 200px;
  align-items: center;
  gap: 10px;
  padding: 5px 14px;
}
.mcol.masked {
  background: var(--accent-soft);
}
.mcname {
  font-family: var(--mono);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pk {
  font-size: 8px;
  font-weight: 700;
  background: var(--bg-elevated);
  color: var(--text-dim);
  padding: 1px 3px;
  border-radius: 3px;
}
.mctype {
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msel {
  font-size: 11.5px;
  padding: 4px 6px;
}
</style>
