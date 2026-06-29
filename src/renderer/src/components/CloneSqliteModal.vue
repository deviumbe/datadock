<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { isSqlDriver, type CloneResult, type TableInfo } from '@shared/types'
import Modal from './Modal.vue'
import Icon from './Icon.vue'

const props = defineProps<{ connId: string; connName: string; driver: string }>()
const emit = defineEmits<{ close: [] }>()

const isSql = computed(() => isSqlDriver(props.driver))

const tables = ref<TableInfo[]>([])
const selected = ref<Set<string>>(new Set())
const includeData = ref(true)
const loading = ref(false)
const cloning = ref(false)
const error = ref('')
const result = ref<CloneResult | null>(null)

const allSelected = computed(
  () => tables.value.length > 0 && selected.value.size === tables.value.length
)

async function reload(): Promise<void> {
  if (!isSql.value) return
  loading.value = true
  error.value = ''
  try {
    const list = (await window.api.db.listTables(props.connId)).filter((t) => t.type === 'table')
    tables.value = list
    selected.value = new Set(list.map((t) => t.name))
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
watch(() => props.connId, reload, { immediate: true })

function toggle(name: string): void {
  const next = new Set(selected.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  selected.value = next
}
function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(tables.value.map((t) => t.name))
}

async function clone(): Promise<void> {
  if (cloning.value || !selected.value.size) return
  cloning.value = true
  error.value = ''
  result.value = null
  try {
    const res = await window.api.clone.toSqlite(props.connId, {
      tables: [...selected.value],
      includeData: includeData.value
    })
    if (!res.canceled) result.value = res
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    cloning.value = false
  }
}
</script>

<template>
  <Modal title="Clone to SQLite" wide @close="emit('close')">
    <div class="clone">
      <p class="intro">
        Copy this database's structure — and optionally its data — into a single
        <strong>portable SQLite file</strong>. Great for a local working copy of a remote schema,
        offline debugging, or sharing a self-contained snapshot.
      </p>

      <div v-if="!isSql" class="state">Cloning to SQLite is available for SQL databases only.</div>

      <template v-else-if="result">
        <div class="done" :class="{ bad: result.errors && result.errors.length }">
          <Icon :name="result.errors && result.errors.length ? 'warn' : 'check'" :size="15" />
          <div>
            <div class="done-head">
              Cloned {{ result.tableCount }} table{{ result.tableCount === 1 ? '' : 's' }}<template
                v-if="includeData"
              >
                · {{ result.rowCount?.toLocaleString() }} rows</template
              >.
            </div>
            <div class="done-path">{{ result.path }}</div>
            <ul v-if="result.errors && result.errors.length" class="done-errs">
              <li v-for="(e, i) in result.errors" :key="i">{{ e }}</li>
            </ul>
          </div>
        </div>
      </template>

      <template v-else>
        <label class="opt">
          <input type="checkbox" v-model="includeData" />
          <span>Include data <em>(uncheck for structure only)</em></span>
        </label>

        <div class="tables-head">
          <span>Tables</span>
          <button class="link" :disabled="!tables.length" @click="toggleAll">
            {{ allSelected ? 'Deselect all' : 'Select all' }}
          </button>
        </div>

        <div v-if="loading && !tables.length" class="state">Loading tables…</div>
        <div v-else-if="!tables.length" class="state">No tables to clone.</div>
        <div v-else class="tlist">
          <label v-for="t in tables" :key="t.name" class="trow">
            <input type="checkbox" :checked="selected.has(t.name)" @change="toggle(t.name)" />
            <Icon name="table" :size="14" />
            <span class="tname">{{ t.name }}</span>
          </label>
        </div>
      </template>

      <p v-if="error" class="err">{{ error }}</p>
    </div>

    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">{{ result ? 'Close' : 'Cancel' }}</button>
      <button
        v-if="isSql && !result"
        class="btn btn-primary"
        :disabled="cloning || !selected.size"
        @click="clone"
      >
        <Icon name="database" :size="13" />
        {{ cloning ? 'Cloning…' : `Clone ${selected.size} table${selected.size === 1 ? '' : 's'}` }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.clone {
  min-width: 520px;
  max-width: 620px;
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.intro {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-dim);
}
.intro strong {
  color: var(--text);
}
.state {
  font-size: 12.5px;
  color: var(--text-dim);
  padding: 16px;
  text-align: center;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
}
.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.opt em {
  color: var(--text-faint);
  font-style: normal;
  font-size: 12px;
}
.tables-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}
.link {
  font-size: 12px;
  color: var(--accent);
  text-transform: none;
  letter-spacing: 0;
}
.link:disabled {
  opacity: 0.5;
}
.tlist {
  display: flex;
  flex-direction: column;
  max-height: 44vh;
  overflow-y: auto;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}
.trow {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 12px;
  font-size: 12.5px;
  cursor: pointer;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border-soft);
}
.trow:last-child {
  border-bottom: none;
}
.trow:hover {
  background: var(--bg-hover);
}
.tname {
  color: var(--text);
}
.trow :deep(.dd-icon) {
  color: var(--accent);
}
.err {
  color: var(--danger);
  font-size: 12px;
  font-family: var(--mono);
}
.done {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 14px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  color: var(--ok);
}
.done.bad {
  color: var(--warn);
}
.done-head {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}
.done-path {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-dim);
  margin-top: 3px;
  word-break: break-all;
}
.done-errs {
  margin: 8px 0 0;
  padding-left: 16px;
  font-size: 11.5px;
  color: var(--warn);
}
</style>
