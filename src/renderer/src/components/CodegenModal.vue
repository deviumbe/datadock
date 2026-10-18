<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import Modal from './Modal.vue'
import Icon from './Icon.vue'
import type { TableInfo, TableStructure } from '@shared/types'
import {
  targetsForLanguage,
  buildTables,
  runTarget,
  type IRTable,
  type Target,
  type GeneratedFile,
  type CodeKind
} from '../lib/codegen'
import { highlight } from '../lib/highlight'

const props = defineProps<{
  connectionId: string
  driver: string
  language: string
  tables: TableInfo[]
}>()
const emit = defineEmits<{ close: [] }>()

const targets = computed(() => targetsForLanguage(props.language))
const selectedId = ref(targets.value[0]?.id ?? '')
const selected = computed<Target | undefined>(() => targets.value.find((t) => t.id === selectedId.value))

// Which tables to include (all on by default).
const included = ref<Record<string, boolean>>(
  Object.fromEntries(props.tables.map((t) => [tKey(t), true]))
)
function tKey(t: TableInfo): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name
}
const includedCount = computed(() => props.tables.filter((t) => included.value[tKey(t)]).length)
function setAll(v: boolean): void {
  for (const t of props.tables) included.value[tKey(t)] = v
}

// Kind selection: model / migration / both, constrained by the target.
type KindMode = 'model' | 'migration' | 'both'
const kindMode = ref<KindMode>('model')

const supportsModel = computed(() => !!selected.value?.kinds.includes('model'))
const supportsMigration = computed(() => !!selected.value?.kinds.includes('migration'))
const supportsBoth = computed(() => supportsModel.value && supportsMigration.value)

// Keep kindMode valid whenever the target changes.
watch(
  selected,
  (t) => {
    if (!t) return
    if (kindMode.value === 'model' && !t.kinds.includes('model')) kindMode.value = 'migration'
    if (kindMode.value === 'migration' && !t.kinds.includes('migration')) kindMode.value = 'model'
    if (kindMode.value === 'both' && !supportsBoth.value)
      kindMode.value = t.kinds.includes('model') ? 'model' : 'migration'
  },
  { immediate: true }
)

const kinds = computed<CodeKind[]>(() =>
  kindMode.value === 'both' ? ['model', 'migration'] : [kindMode.value]
)

// ---- lazy structure loading & IR cache -------------------------------------
// Structures are fetched on demand (only for included tables) and cached, so a
// whole-database export of hundreds of tables doesn't fetch everything upfront
// and narrowing the selection never re-fetches.

const error = ref('')
const cache = ref<Record<string, IRTable>>({})
const pending = ref(0)

async function ensureLoaded(list: TableInfo[]): Promise<void> {
  const missing = list.filter((t) => !cache.value[tKey(t)])
  if (!missing.length) return
  pending.value += missing.length
  await Promise.all(
    missing.map(async (t) => {
      try {
        const s = (await window.api.db.tableStructure(props.connectionId, {
          schema: t.schema,
          name: t.name,
          type: t.type
        })) as TableStructure
        cache.value[tKey(t)] = buildTables([{ name: t.name, structure: s }])[0]
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
      } finally {
        pending.value--
      }
    })
  )
}

watch(
  () => props.tables.filter((t) => included.value[tKey(t)]).map(tKey),
  () => void ensureLoaded(props.tables.filter((t) => included.value[tKey(t)])),
  { immediate: true }
)

const loading = computed(() => pending.value > 0)
const irTables = computed<IRTable[]>(() =>
  props.tables
    .filter((t) => included.value[tKey(t)])
    .map((t) => cache.value[tKey(t)])
    .filter((x): x is IRTable => !!x)
)

// ---- generate ---------------------------------------------------------------

const files = computed<GeneratedFile[]>(() => {
  if (!selected.value || !irTables.value.length) return []
  try {
    return runTarget(selected.value, irTables.value, { kinds: kinds.value, driver: props.driver })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return []
  }
})

const activeFile = ref(0)
watch(files, () => {
  if (activeFile.value >= files.value.length) activeFile.value = 0
})

const current = computed(() => files.value[activeFile.value])
const highlighted = computed(() =>
  current.value ? highlight(current.value.content, current.value.lang) : ''
)
const allContent = computed(() =>
  files.value.map((f) => `// ${f.filename}\n${f.content}`).join('\n\n')
)

// ---- actions ----------------------------------------------------------------

const copied = ref('')
async function copy(text: string, tag: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  copied.value = tag
  setTimeout(() => (copied.value = ''), 1200)
}
async function saveCurrent(): Promise<void> {
  if (!current.value) return
  await window.api.io.saveFile(current.value.filename, current.value.content, false)
}
const savedAll = ref('')
async function saveAll(): Promise<void> {
  if (!files.value.length) return
  const res = await window.api.io.saveFiles(
    files.value.map((f) => ({ filename: f.filename, content: f.content }))
  )
  if (!res.canceled) {
    savedAll.value = `Saved ${res.count} files`
    setTimeout(() => (savedAll.value = ''), 2000)
  }
}
</script>

<template>
  <Modal :title="`Generate ${language} code`" size="xl" @close="emit('close')">
    <div class="cg">
      <!-- framework list -->
      <aside class="cg-frameworks">
        <div class="cg-section-label">Framework / package</div>
        <button
          v-for="t in targets"
          :key="t.id"
          class="cg-fw"
          :class="{ on: t.id === selectedId }"
          @click="selectedId = t.id"
        >
          <div class="cg-fw-head">
            <span class="cg-fw-name">{{ t.label }}</span>
            <span class="cg-kind-badges">
              <span v-if="t.kinds.includes('model')" class="cg-badge m">M</span>
              <span v-if="t.kinds.includes('migration')" class="cg-badge g">S</span>
            </span>
          </div>
          <div v-if="t.note" class="cg-fw-note">{{ t.note }}</div>
        </button>
      </aside>

      <!-- output -->
      <section class="cg-output">
        <div class="cg-controls">
          <div v-if="supportsBoth" class="cg-seg">
            <button :class="{ on: kindMode === 'model' }" @click="kindMode = 'model'">Models</button>
            <button :class="{ on: kindMode === 'migration' }" @click="kindMode = 'migration'">
              Migrations
            </button>
            <button :class="{ on: kindMode === 'both' }" @click="kindMode = 'both'">Both</button>
          </div>
          <div v-else class="cg-single-kind">
            {{ supportsModel ? 'Models' : 'Migration' }}
          </div>

          <div class="cg-one-table" v-if="tables.length === 1">
            <Icon name="table" :size="12" /> {{ tables[0]?.name }}
          </div>
        </div>

        <div class="cg-tablesel" v-if="tables.length > 1">
          <div class="cg-tablesel-head">
            <span class="cg-section-label inline">Tables · {{ includedCount }}/{{ tables.length }}</span>
            <button class="cg-mini" @click="setAll(true)">All</button>
            <button class="cg-mini" @click="setAll(false)">None</button>
          </div>
          <div class="cg-tablesel-list">
            <label
              v-for="t in tables"
              :key="tKey(t)"
              class="cg-tbl"
              :class="{ on: included[tKey(t)] }"
            >
              <input type="checkbox" v-model="included[tKey(t)]" />
              {{ t.name }}
            </label>
          </div>
        </div>

        <div class="cg-preview">
          <div v-if="loading" class="cg-msg">Loading schema…</div>
          <div v-else-if="error" class="cg-msg err">{{ error }}</div>
          <div v-else-if="!files.length" class="cg-msg">Nothing to generate.</div>
          <template v-else>
            <div v-if="files.length > 1" class="cg-file-tabs">
              <button
                v-for="(f, i) in files"
                :key="i"
                class="cg-file-tab"
                :class="{ on: i === activeFile }"
                @click="activeFile = i"
              >
                {{ f.filename }}
              </button>
            </div>
            <div v-else class="cg-file-name">{{ current?.filename }}</div>
            <pre class="cg-code"><code v-html="highlighted"></code></pre>
          </template>
        </div>
      </section>
    </div>

    <template #footer>
      <span class="cg-count" v-if="files.length">
        {{ savedAll || `${files.length} file${files.length === 1 ? '' : 's'}` }}
      </span>
      <button
        v-if="files.length > 1"
        class="btn"
        :disabled="!files.length"
        @click="saveAll"
      >
        <Icon name="download" :size="13" /> Save all…
      </button>
      <button v-else class="btn" :disabled="!current" @click="saveCurrent">
        <Icon name="download" :size="13" /> Save file…
      </button>
      <button
        v-if="files.length > 1"
        class="btn"
        :disabled="!files.length"
        @click="copy(allContent, 'all')"
      >
        {{ copied === 'all' ? 'Copied!' : 'Copy all' }}
      </button>
      <button
        class="btn btn-primary"
        :disabled="!current"
        @click="copy(current?.content ?? '', 'one')"
      >
        {{ copied === 'one' ? 'Copied!' : 'Copy' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.cg {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 14px;
  height: 70vh;
  min-height: 420px;
}
.cg-section-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
  margin-bottom: 6px;
}
.cg-section-label.inline {
  margin: 0 6px 0 0;
}
.cg-frameworks {
  overflow-y: auto;
  border-right: 1px solid var(--border-soft);
  padding-right: 12px;
}
.cg-fw {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  margin-bottom: 3px;
  transition: background var(--dur-1);
}
.cg-fw:hover {
  background: var(--bg-hover);
}
.cg-fw.on {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.cg-fw-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.cg-fw-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.cg-fw.on .cg-fw-name {
  color: var(--accent);
}
.cg-fw-note {
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 2px;
}
.cg-kind-badges {
  display: flex;
  gap: 3px;
}
.cg-badge {
  font-size: 9px;
  font-weight: 700;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
}
.cg-badge.m {
  background: var(--accent-soft);
  color: var(--accent);
}
.cg-badge.g {
  background: var(--bg-hover);
  color: var(--text-dim);
}
.cg-output {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.cg-controls {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.cg-seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.cg-seg button {
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-dim);
  border-right: 1px solid var(--border);
}
.cg-seg button:last-child {
  border-right: none;
}
.cg-seg button.on {
  background: var(--accent);
  color: #fff;
}
.cg-single-kind {
  font-size: 12px;
  color: var(--text-dim);
  padding: 4px 0;
}
.cg-one-table {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-dim);
}
.cg-tablesel {
  margin-bottom: 10px;
}
.cg-tablesel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
}
.cg-mini {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
}
.cg-mini:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.cg-tablesel-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  max-height: 84px;
  overflow-y: auto;
  padding: 6px 8px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
}
.cg-tbl {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-faint);
  cursor: pointer;
}
.cg-tbl.on {
  color: var(--text);
}
.cg-preview {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-app);
}
.cg-file-tabs {
  display: flex;
  gap: 2px;
  padding: 5px 5px 0;
  overflow-x: auto;
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.cg-file-tab {
  padding: 4px 10px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-dim);
  border-radius: 4px 4px 0 0;
  white-space: nowrap;
}
.cg-file-tab.on {
  background: var(--bg-elevated);
  color: var(--text);
}
.cg-file-name {
  padding: 6px 10px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-faint);
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.cg-code {
  flex: 1;
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.55;
  color: var(--text);
  white-space: pre;
  tab-size: 2;
}
/* Syntax highlight tokens (palette matches the SQL editor). */
.cg-code :deep(.hl-kw) {
  color: var(--syn-keyword);
  font-weight: 600;
}
.cg-code :deep(.hl-str) {
  color: var(--syn-string);
}
.cg-code :deep(.hl-num),
.cg-code :deep(.hl-lit) {
  color: var(--syn-number);
}
.cg-code :deep(.hl-com) {
  color: var(--syn-comment);
  font-style: italic;
}
.cg-code :deep(.hl-fn) {
  color: var(--syn-function);
}
.cg-code :deep(.hl-type) {
  color: var(--syn-type);
}
.cg-code :deep(.hl-dec) {
  color: #e0a458;
}
.cg-msg {
  padding: 24px;
  color: var(--text-faint);
  font-size: 13px;
}
.cg-msg.err {
  color: var(--danger);
  white-space: pre-wrap;
}
.cg-count {
  flex: 1;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
