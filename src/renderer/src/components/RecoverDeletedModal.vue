<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { sqlDialect, isSqlDriver, type QueryResult } from '@shared/types'
import { useWorkspace } from '../stores/workspace'
import { useUi } from '../stores/ui'
import Modal from './Modal.vue'
import Icon from './Icon.vue'
import ResultsGrid from './ResultsGrid.vue'

const props = defineProps<{ connId: string; driver: string; readOnly: boolean }>()
const emit = defineEmits<{ changed: [table: string]; close: [] }>()

const ws = useWorkspace()
const ui = useUi()

// Common "soft delete" timestamp columns: a non-null value means the row is
// hidden. (Boolean flags vary too much by dialect to handle safely here.)
const SOFT_COLS = ['deleted_at', 'archived_at', 'removed_at']

const isSql = computed(() => isSqlDriver(props.driver))
const dialect = computed(() => sqlDialect(props.driver))
const tq = computed(() => (dialect.value === 'mysql' ? '`' : '"'))
const q = (n: string): string => `${tq.value}${n}${tq.value}`

interface Candidate {
  table: string
  col: string
  count: number
}
const candidates = ref<Candidate[]>([])
const scanning = ref(false)
const error = ref('')

function softColOf(table: string): string | null {
  const cols = ws.schemas[props.connId]?.[table] ?? []
  return cols.find((c) => SOFT_COLS.includes(c.toLowerCase())) ?? null
}

async function scan(): Promise<void> {
  if (!isSql.value) return
  scanning.value = true
  error.value = ''
  try {
    const found = ws.tables
      .filter((t) => t.type !== 'view')
      .map((t) => ({ table: t.name, col: softColOf(t.name) }))
      .filter((x): x is { table: string; col: string } => !!x.col)
    const results = await Promise.all(
      found.map(async (f) => {
        try {
          const r = await window.api.db.query(
            props.connId,
            `SELECT COUNT(*) AS n FROM ${q(f.table)} WHERE ${q(f.col)} IS NOT NULL`
          )
          return { ...f, count: Number(r.rows[0]?.[0] ?? 0) }
        } catch {
          return { ...f, count: 0 }
        }
      })
    )
    candidates.value = results.filter((c) => c.count > 0).sort((a, b) => b.count - a.count)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    scanning.value = false
  }
}
watch(() => props.connId, scan, { immediate: true })

// ---- preview the deleted rows ----
const openTable = ref('')
const previewResult = ref<QueryResult | null>(null)
const previewLoading = ref(false)
async function togglePreview(c: Candidate): Promise<void> {
  if (openTable.value === c.table) {
    openTable.value = ''
    return
  }
  openTable.value = c.table
  previewResult.value = null
  previewLoading.value = true
  try {
    const top = dialect.value === 'mssql' ? 'TOP 200 ' : ''
    const tail = dialect.value === 'mssql' ? '' : ' LIMIT 200'
    previewResult.value = await window.api.db.query(
      props.connId,
      `SELECT ${top}* FROM ${q(c.table)} WHERE ${q(c.col)} IS NOT NULL${tail}`
    )
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewLoading.value = false
  }
}

// ---- restore ----
const restoring = ref('')
async function restoreAll(c: Candidate): Promise<void> {
  if (props.readOnly || restoring.value) return
  const ok = await ui.confirmDialog({
    title: 'Restore deleted rows?',
    message: `Bring back all ${c.count} soft-deleted row${c.count === 1 ? '' : 's'} in “${c.table}” by clearing their ${c.col}. They'll reappear in normal queries.`,
    confirmLabel: 'Restore rows'
  })
  if (!ok) return
  restoring.value = c.table
  error.value = ''
  try {
    await window.api.db.query(
      props.connId,
      `UPDATE ${q(c.table)} SET ${q(c.col)} = NULL WHERE ${q(c.col)} IS NOT NULL`
    )
    openTable.value = ''
    emit('changed', c.table)
    await scan()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    restoring.value = ''
  }
}
</script>

<template>
  <Modal title="Recover deleted rows" wide @close="emit('close')">
    <div class="rec">
      <p class="intro">
        Many apps don't really delete data — they mark a row as gone with a
        <code>deleted_at</code> timestamp. This finds those hidden rows so you can bring them back.
      </p>

      <div v-if="!isSql" class="state">Available for SQL databases only.</div>
      <div v-else-if="scanning && !candidates.length" class="state">Scanning tables…</div>
      <div v-else-if="!candidates.length" class="empty">
        <Icon name="check" :size="15" /> No soft-deleted rows found — every table looks clean.
      </div>

      <p v-if="error" class="err">{{ error }}</p>

      <div v-if="isSql" class="list">
        <div v-for="c in candidates" :key="c.table" class="rec-row" :class="{ open: openTable === c.table }">
          <div class="rec-main">
            <button class="rec-toggle" @click="togglePreview(c)">
              <span class="caret" :class="{ open: openTable === c.table }"><Icon name="chevronRight" :size="13" /></span>
              <Icon name="table" :size="14" />
              <span class="rec-table">{{ c.table }}</span>
              <span class="rec-count">{{ c.count }} hidden</span>
              <span class="rec-col">{{ c.col }}</span>
            </button>
            <button
              class="btn btn-primary rec-restore"
              :disabled="readOnly || restoring === c.table"
              :title="readOnly ? 'Connection is read-only' : 'Clear the delete flag on all these rows'"
              @click="restoreAll(c)"
            >{{ restoring === c.table ? 'Restoring…' : 'Restore all' }}</button>
          </div>
          <div v-if="openTable === c.table" class="rec-preview">
            <div v-if="previewLoading" class="state">Loading rows…</div>
            <div v-else-if="previewResult && previewResult.columns.length" class="rec-grid">
              <ResultsGrid :result="previewResult" />
            </div>
            <div v-else class="state">No rows to show.</div>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <button class="btn btn-ghost" :disabled="scanning" @click="scan">{{ scanning ? 'Scanning…' : 'Rescan' }}</button>
      <button class="btn btn-ghost" @click="emit('close')">Close</button>
    </template>
  </Modal>
</template>

<style scoped>
.rec {
  min-width: 560px;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.intro {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-dim);
}
.intro code {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text);
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
}
.state {
  font-size: 12.5px;
  color: var(--text-dim);
  padding: 14px;
  text-align: center;
}
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--ok);
  padding: 18px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
}
.err {
  color: var(--danger);
  font-size: 12px;
  font-family: var(--mono);
}
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 52vh;
  overflow-y: auto;
}
.rec-row {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  overflow: hidden;
}
.rec-row.open {
  border-color: var(--border-strong);
}
.rec-main {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}
.rec-toggle {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--accent);
  text-align: left;
}
.caret {
  display: inline-flex;
  color: var(--text-faint);
  transition: transform 0.14s;
}
.caret.open {
  transform: rotate(90deg);
}
.rec-table {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}
.rec-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--warn);
  background: rgba(240, 180, 41, 0.13);
  padding: 1px 8px;
  border-radius: 999px;
}
.rec-col {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-faint);
  margin-left: auto;
}
.rec-restore {
  flex: none;
  padding: 5px 13px;
  border-radius: 999px;
}
.rec-preview {
  border-top: 1px solid var(--border-soft);
}
.rec-grid {
  height: 240px;
  overflow: hidden;
}
</style>
