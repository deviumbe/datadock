<script setup lang="ts">
import { ref, computed } from 'vue'
import type { TableInfo } from '@shared/types'
import { diffData, type DataDiffResult } from '../lib/dataDiff'

const props = defineProps<{
  connId: string
  connName: string
  candidates: { id: string; label: string }[]
  tables: TableInfo[]
}>()

const CAP = 5000
const targetId = ref('')
const tableName = ref('')
const busy = ref(false)
const error = ref('')
const result = ref<DataDiffResult | null>(null)
const capped = ref(false)

const display = (v: unknown): string => (v === null || v === undefined ? 'NULL' : String(v))

async function fetchRows(id: string, table: TableInfo): Promise<{ columns: string[]; rows: unknown[][] }> {
  const limit = 2000
  let offset = 0
  let columns: string[] = []
  const rows: unknown[][] = []
  for (;;) {
    const r = await window.api.db.tableData(id, table, { limit, offset })
    if (!columns.length) columns = r.columns.map((c) => c.name)
    rows.push(...r.rows)
    if (r.rows.length < limit || rows.length >= CAP) break
    offset += limit
  }
  if (rows.length >= CAP) capped.value = true
  return { columns, rows: rows.slice(0, CAP) }
}

async function run(): Promise<void> {
  const table = props.tables.find((t) => t.name === tableName.value)
  if (!targetId.value || !table) return
  busy.value = true
  error.value = ''
  result.value = null
  capped.value = false
  try {
    await window.api.db.connect(targetId.value)
    const pk = await window.api.db.primaryKeys(props.connId, {
      schema: table.schema,
      name: table.name,
      type: table.type
    })
    if (pk.length === 0) {
      error.value = 'This table has no primary key, so rows can’t be matched for a diff.'
      return
    }
    const plain = { schema: table.schema, name: table.name, type: table.type }
    const [a, b] = await Promise.all([fetchRows(props.connId, plain), fetchRows(targetId.value, plain)])
    result.value = diffData(a.columns, a.rows, b.columns, b.rows, pk)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

const diffs = computed(() => result.value?.rows ?? [])
</script>

<template>
  <div class="diff">
    <div class="toolbar">
      <strong>Data Diff</strong>
      <span class="muted">{{ connName }}</span>
      <span class="arrow">↔</span>
      <select class="select" v-model="targetId" :disabled="busy">
        <option value="" disabled>Compare with…</option>
        <option v-for="c in candidates" :key="c.id" :value="c.id">{{ c.label }}</option>
      </select>
      <select class="select" v-model="tableName" :disabled="busy">
        <option value="" disabled>Table…</option>
        <option v-for="t in tables" :key="t.name" :value="t.name">{{ t.name }}</option>
      </select>
      <button class="btn btn-primary" :disabled="!targetId || !tableName || busy" @click="run">
        {{ busy ? 'Comparing…' : 'Compare' }}
      </button>
    </div>

    <div v-if="error" class="err">{{ error }}</div>
    <div v-if="!result && !busy && !error" class="empty">
      Pick a target connection and a table to compare row-by-row (matched by primary key).
    </div>

    <template v-if="result">
      <div class="summary">
        <span class="s same">{{ result.sameCount }} identical</span>
        <span class="s changed">{{ result.changedCount }} changed</span>
        <span class="s removed">{{ result.removedCount }} only in {{ connName }}</span>
        <span class="s added">{{ result.addedCount }} only in target</span>
        <span v-if="capped" class="s cap">⚠ compared first {{ CAP }} rows per side</span>
      </div>
      <div class="list">
        <div v-for="d in diffs" :key="d.key" class="rrow" :class="d.status">
          <span class="rmark">{{ d.status === 'added' ? '+' : d.status === 'removed' ? '−' : '~' }}</span>
          <span class="rpk">{{ d.pk }}</span>
          <span class="rdetail">
            <template v-if="d.status === 'changed'">
              <span v-for="ch in d.changes" :key="ch.col" class="chg">
                {{ ch.col }}: {{ display(ch.a) }} → {{ display(ch.b) }}
              </span>
            </template>
            <template v-else-if="d.status === 'removed'">only in {{ connName }}</template>
            <template v-else>only in target</template>
          </span>
        </div>
        <div v-if="diffs.length === 0" class="empty">Rows are identical. 🎉</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.diff {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.muted {
  color: var(--text-dim);
  font-size: 12px;
}
.arrow {
  color: var(--text-faint);
}
.select {
  max-width: 260px;
}
.err {
  padding: 10px 12px;
  background: rgba(229, 97, 106, 0.13);
  color: var(--danger);
  font-family: var(--mono);
  font-size: 12px;
}
.empty {
  padding: 30px;
  color: var(--text-faint);
}
.summary {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  flex-shrink: 0;
}
.summary .changed {
  color: var(--warn);
}
.summary .removed {
  color: var(--danger);
}
.summary .added {
  color: var(--ok);
}
.summary .same,
.summary .cap {
  color: var(--text-faint);
}
.list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
  font-family: var(--mono);
  font-size: 12px;
}
.rrow {
  display: flex;
  gap: 10px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
}
.rrow.added {
  color: var(--ok);
}
.rrow.removed {
  color: var(--danger);
}
.rrow.changed {
  color: var(--warn);
}
.rmark {
  width: 12px;
  font-weight: 700;
}
.rpk {
  min-width: 120px;
  color: var(--text);
}
.rdetail {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--text-dim);
}
.chg {
  white-space: nowrap;
}
</style>
