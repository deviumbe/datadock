<script setup lang="ts">
import { ref, computed } from 'vue'
import { isSqlDriver, type QueryResult } from '@shared/types'
import { useTabs } from '../stores/tabs'
import { textColumns, buildSearchSql } from '../lib/search'
import ResultsGrid from './ResultsGrid.vue'

const props = defineProps<{ connId: string; driver: string }>()
const tabsStore = useTabs()

const isSql = computed(() => isSqlDriver(props.driver))

const term = ref('')
const running = ref(false)
const progress = ref(0)
const totalTables = ref(0)
const scanned = ref(false)
const error = ref('')
let runId = 0

// ---- excluded tables (persisted per connection) -----------------------------
// Large / irrelevant tables can be skipped to keep "search everywhere" fast.
const EXCLUDE_KEY = 'datadock-search-excludes'
function loadExcluded(): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(EXCLUDE_KEY) || '{}')
    return new Set<string>(all[props.connId] ?? [])
  } catch {
    return new Set()
  }
}
const excluded = ref<Set<string>>(loadExcluded())
function saveExcluded(): void {
  let all: Record<string, string[]> = {}
  try {
    all = JSON.parse(localStorage.getItem(EXCLUDE_KEY) || '{}')
  } catch {
    /* ignore */
  }
  all[props.connId] = [...excluded.value]
  try {
    localStorage.setItem(EXCLUDE_KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable */
  }
}
function toggleExclude(name: string): void {
  const next = new Set(excluded.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  excluded.value = next
  saveExcluded()
}

const manageOpen = ref(false)
const allTables = ref<string[]>([])
const tableFilter = ref('')
const shownTables = computed(() => {
  const f = tableFilter.value.toLowerCase().trim()
  return f ? allTables.value.filter((n) => n.toLowerCase().includes(f)) : allTables.value
})
async function toggleManage(): Promise<void> {
  manageOpen.value = !manageOpen.value
  if (manageOpen.value && !allTables.value.length) {
    try {
      const snap = await window.api.db.schemaSnapshot(props.connId)
      allTables.value = snap.map((t) => t.name).sort((a, b) => a.localeCompare(b))
    } catch {
      /* leave list empty */
    }
  }
}
function clearExcluded(): void {
  excluded.value = new Set()
  saveExcluded()
}

interface Hit {
  table: string
  result: QueryResult
  open: boolean
}
const hits = ref<Hit[]>([])
const totalMatches = computed(() => hits.value.reduce((a, h) => a + h.result.rows.length, 0))

function stop(): void {
  runId++
  running.value = false
}

async function search(): Promise<void> {
  const q = term.value.trim()
  if (!q || !isSql.value) return
  const myRun = ++runId
  running.value = true
  scanned.value = true
  error.value = ''
  hits.value = []
  progress.value = 0
  try {
    const snapshot = await window.api.db.schemaSnapshot(props.connId)
    const targets = snapshot
      .map((t) => ({ name: t.name, cols: textColumns(t) }))
      .filter((t) => t.cols.length && !excluded.value.has(t.name))
    totalTables.value = targets.length
    for (const t of targets) {
      if (runId !== myRun) return // superseded or stopped
      try {
        const sql = buildSearchSql(props.driver, t.name, t.cols, q, 20)
        const result = await window.api.db.query(props.connId, sql)
        if (result.rows.length) {
          hits.value = [...hits.value, { table: t.name, result, open: hits.value.length < 3 }]
        }
      } catch {
        /* skip tables that error (odd types/permissions) */
      }
      progress.value++
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (runId === myRun) running.value = false
  }
}

function openTable(table: string): void {
  tabsStore.openTable(props.connId, { name: table, type: 'table' })
}
</script>

<template>
  <div class="search">
    <header class="search-head">
      <div class="searchbox">
        <span class="ic">⌕</span>
        <input
          v-model="term"
          class="sinput"
          placeholder="Find any value across every table…"
          :disabled="!isSql"
          @keydown.enter="search"
        />
        <button
          class="btn btn-ghost excl-btn"
          :class="{ active: excluded.size }"
          :disabled="!isSql"
          title="Choose which tables to skip when searching"
          @click="toggleManage"
        >
          ⛔ Exclude<span v-if="excluded.size" class="excl-badge">{{ excluded.size }}</span>
        </button>
        <button v-if="running" class="btn btn-ghost" @click="stop">Stop</button>
        <button v-else class="btn btn-primary" :disabled="!term.trim() || !isSql" @click="search">Search</button>
      </div>

      <div v-if="manageOpen" class="manage">
        <div class="manage-top">
          <input v-model="tableFilter" class="manage-filter" placeholder="Filter tables…" />
          <button v-if="excluded.size" class="btn btn-ghost sm" @click="clearExcluded">Clear ({{ excluded.size }})</button>
        </div>
        <p class="manage-hint">Unchecked tables are skipped during search — handy for large, irrelevant tables.</p>
        <div class="manage-list">
          <label v-for="name in shownTables" :key="name" class="trow">
            <input type="checkbox" :checked="!excluded.has(name)" @change="toggleExclude(name)" />
            <span class="tname" :class="{ off: excluded.has(name) }">{{ name }}</span>
          </label>
          <div v-if="!allTables.length" class="state sm">Loading tables…</div>
          <div v-else-if="!shownTables.length" class="state sm">No tables match.</div>
        </div>
      </div>
      <div v-if="running || scanned" class="status">
        <template v-if="running">Scanning {{ progress }}/{{ totalTables }} tables…</template>
        <template v-else>{{ totalMatches }} match{{ totalMatches === 1 ? '' : 'es' }} across {{ hits.length }} table{{ hits.length === 1 ? '' : 's' }}<span v-if="excluded.size"> · {{ excluded.size }} excluded</span></template>
      </div>
    </header>

    <div v-if="running" class="pbar"><div class="pfill" :style="{ width: totalTables ? (progress / totalTables) * 100 + '%' : '0%' }" /></div>

    <div class="body">
      <div v-if="!isSql" class="state">Universal search isn't available for {{ driver }}.</div>
      <div v-else-if="error" class="state err">{{ error }}</div>
      <div v-else-if="!scanned" class="state">
        <div class="big">⌕</div>
        <p>Type a value and hit Search to find it anywhere in this database — every text column of every table is scanned.</p>
      </div>
      <div v-else-if="!hits.length && !running" class="state">No matches found for “{{ term }}”.</div>

      <div v-for="(h, i) in hits" :key="i" class="hit">
        <div class="hit-head" @click="h.open = !h.open">
          <span class="caret" :class="{ open: h.open }">▸</span>
          <strong>{{ h.table }}</strong>
          <span class="hcount">{{ h.result.rows.length }}{{ h.result.rows.length === 20 ? '+' : '' }}</span>
          <div class="spacer" />
          <button class="btn btn-ghost sm" @click.stop="openTable(h.table)">Open table →</button>
        </div>
        <div v-if="h.open" class="hit-grid">
          <ResultsGrid :result="h.result" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
  overflow: hidden;
}
.search-head {
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.searchbox {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ic {
  font-size: 16px;
  color: var(--text-faint);
}
.sinput {
  flex: 1;
  font-size: 14px;
  padding: 9px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  outline: none;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.sinput::placeholder {
  color: var(--text-faint);
}
.sinput:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.status {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-faint);
}
.excl-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.excl-btn.active {
  color: var(--accent);
}
.excl-badge {
  font-size: 11px;
  font-weight: 600;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 999px;
  padding: 0 6px;
}
.manage {
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
  padding: 10px 12px;
}
.manage-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.manage-filter {
  flex: 1;
  font-size: 13px;
  padding: 6px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  outline: none;
}
.manage-filter:focus {
  border-color: var(--accent);
}
.manage-hint {
  margin: 8px 2px 6px;
  font-size: 11.5px;
  color: var(--text-faint);
}
.manage-list {
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.trow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  cursor: pointer;
}
.trow:hover {
  background: var(--bg-hover);
}
.tname {
  font-family: var(--mono);
  color: var(--text);
}
.tname.off {
  color: var(--text-faint);
  text-decoration: line-through;
}
.pbar {
  height: 3px;
  background: var(--bg-elevated);
  flex: none;
}
.pfill {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s ease;
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px 40px;
}
.state {
  margin: auto;
  text-align: center;
  color: var(--text-dim);
  font-size: 13px;
  max-width: 440px;
  padding: 50px 20px;
}
.state.err {
  color: var(--danger);
}
.big {
  font-size: 40px;
  color: var(--text-faint);
  margin-bottom: 10px;
}
.hit {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 10px;
  overflow: hidden;
}
.hit-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  background: var(--bg-panel);
  cursor: pointer;
}
.hit-head:hover {
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
.hcount {
  font-size: 11px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 999px;
  padding: 1px 8px;
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.btn.sm {
  padding: 4px 9px;
  font-size: 11.5px;
}
.hit-grid {
  max-height: 320px;
  overflow: auto;
  border-top: 1px solid var(--border);
}
</style>
