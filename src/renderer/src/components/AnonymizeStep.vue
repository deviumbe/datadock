<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { MASK_OPTIONS, guessMask, type MaskType, type MaskConfig, type MaskOption } from '@shared/mask'
import type { SchemaTable, TableInfo } from '@shared/types'

const props = defineProps<{ connId: string; dataTables: TableInfo[] }>()
const emit = defineEmits<{ 'update:modelValue': [MaskConfig | undefined] }>()

const schema = ref<SchemaTable[]>([])
const schemaLoaded = ref(false)
const masks = reactive<Record<string, Record<string, MaskType>>>({})
const expanded = reactive<Set<string>>(new Set())

const maskGroups = computed(() => {
  const g: Record<string, MaskOption[]> = {}
  for (const o of MASK_OPTIONS) if (o.value !== 'none') (g[o.group] ??= []).push(o)
  return g
})

function columnsFor(name: string): SchemaTable['columns'] {
  return schema.value.find((s) => s.name === name)?.columns ?? []
}
function tableMaskedCount(name: string): number {
  const m = masks[name]
  return m ? columnsFor(name).filter((c) => m[c.name] && m[c.name] !== 'none').length : 0
}
const maskedCount = computed(() => props.dataTables.reduce((n, t) => n + tableMaskedCount(t.name), 0))

function buildConfig(): MaskConfig | undefined {
  const cfg: MaskConfig = {}
  for (const t of props.dataTables) {
    const m = masks[t.name]
    if (!m) continue
    const cols: Record<string, MaskType> = {}
    for (const c of columnsFor(t.name)) if (m[c.name] && m[c.name] !== 'none') cols[c.name] = m[c.name]
    if (Object.keys(cols).length) cfg[t.name] = cols
  }
  return Object.keys(cfg).length ? cfg : undefined
}
function emitConfig(): void {
  emit('update:modelValue', buildConfig())
}

function applyGuesses(): void {
  for (const t of schema.value) {
    const m = (masks[t.name] ??= {})
    for (const c of t.columns) m[c.name] = guessMask(c.name, c.type)
  }
  emitConfig()
}
function clearAll(): void {
  for (const t of schema.value) {
    const m = (masks[t.name] ??= {})
    for (const c of t.columns) m[c.name] = 'none'
  }
  emitConfig()
}
function toggle(name: string): void {
  expanded.has(name) ? expanded.delete(name) : expanded.add(name)
}

onMounted(async () => {
  schema.value = await window.api.db.schemaSnapshot(props.connId).catch(() => [])
  schemaLoaded.value = true
  applyGuesses()
  for (const t of props.dataTables) if (tableMaskedCount(t.name) > 0) expanded.add(t.name)
})

// If the set of data-exporting tables changes (caller toggled table modes),
// re-emit so tables no longer exporting data drop out of the config.
watch(
  () => props.dataTables.map((t) => t.name).join(','),
  () => {
    if (schemaLoaded.value) emitConfig()
  }
)
</script>

<template>
  <div class="mask-intro">
    <div>
      <strong>Data masking</strong> — replace sensitive columns with realistic fake data so you can
      safely copy production into another database.
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
        <span v-if="tableMaskedCount(t.name)" class="mbadge">{{ tableMaskedCount(t.name) }} masked</span>
        <span class="mcount">{{ columnsFor(t.name).length }} cols</span>
      </button>
      <div v-if="expanded.has(t.name)" class="mcols">
        <div
          v-for="c in columnsFor(t.name)"
          :key="c.name"
          class="mcol"
          :class="{ masked: masks[t.name]?.[c.name] && masks[t.name][c.name] !== 'none' }"
        >
          <span class="mcname">{{ c.name }}<span v-if="c.isPrimaryKey" class="pk">PK</span></span>
          <span class="mctype">{{ c.type }}</span>
          <select class="select msel" v-model="masks[t.name][c.name]" @change="emitConfig">
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

<style scoped>
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
.empty {
  padding: 20px;
  text-align: center;
  color: var(--text-faint);
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
