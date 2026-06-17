<script setup lang="ts">
import { ref, computed } from 'vue'
import type { QueryResult } from '@shared/types'
import { useTabs } from '../stores/tabs'
import { textColumns, buildSearchSql } from '../lib/search'
import ResultsGrid from './ResultsGrid.vue'

const props = defineProps<{ connId: string; driver: string }>()
const tabsStore = useTabs()

const isSql = computed(() => ['postgres', 'mysql', 'sqlite', 'mssql'].includes(props.driver))

const term = ref('')
const running = ref(false)
const progress = ref(0)
const totalTables = ref(0)
const scanned = ref(false)
const error = ref('')
let runId = 0

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
      .filter((t) => t.cols.length)
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
        <button v-if="running" class="btn btn-ghost" @click="stop">Stop</button>
        <button v-else class="btn btn-primary" :disabled="!term.trim() || !isSql" @click="search">Search</button>
      </div>
      <div v-if="running || scanned" class="status">
        <template v-if="running">Scanning {{ progress }}/{{ totalTables }} tables…</template>
        <template v-else>{{ totalMatches }} match{{ totalMatches === 1 ? '' : 'es' }} across {{ hits.length }} table{{ hits.length === 1 ? '' : 's' }}</template>
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
  padding: 8px 12px;
}
.status {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-faint);
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
