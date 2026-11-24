<script setup lang="ts">
import Icon from './Icon.vue'
import { ref, reactive, onMounted, watch } from 'vue'
import { useTabs } from '../stores/tabs'
import type { InvestigationReport, InvestigationType, FindingSeverity } from '@shared/types'

const props = defineProps<{
  connId: string
  init?: { type: InvestigationType; sql?: string; question?: string }
}>()

const tabsStore = useTabs()

const aiReady = ref(true)
const sql = ref('')
const question = ref('')
const running = ref(false)
const error = ref('')
const report = ref<InvestigationReport | null>(null)
const activeType = ref<InvestigationType | null>(null)

interface Card {
  type: InvestigationType
  icon: string
  title: string
  blurb: string
}
const cards: Card[] = [
  { type: 'query', icon: 'search', title: 'Query Investigation', blurb: 'Why is this query slow? Gathers the plan, indexes, stats, locks & running queries, then explains the primary cause.' },
  { type: 'rootCause', icon: 'target', title: 'Root Cause Analysis', blurb: 'Describe a symptom ("why did revenue drop?"). Correlates query history & errors, last-write-per-table, growth, replication & job queues to find the most likely cause.' },
  { type: 'health', icon: 'check', title: 'Database Health Check', blurb: 'An overall health score from missing/duplicate indexes, seq scans, stale stats, missing keys and long-running queries.' },
  { type: 'dataQuality', icon: 'filter', title: 'Data Quality Inspector', blurb: 'Scans for high-NULL columns, invalid emails, future-dated rows and orphaned foreign-key rows, with safe cleanup SQL.' },
  { type: 'relationships', icon: 'diagram', title: 'Relationship Discovery', blurb: 'Finds undeclared foreign keys from naming + real referential overlap, with a confidence score and the ALTER statement.' },
  { type: 'security', icon: 'lock', title: 'Security & Privacy Audit', blurb: 'Flags plaintext passwords, embedded PII, sensitive columns and over-privileged accounts. Raw secret values never leave your machine.' },
  { type: 'dashboard', icon: 'chart', title: 'Dashboard Narrator', blurb: 'An executive summary of your analytics dashboards — computes the widgets and narrates the numbers for stakeholders.' },
  { type: 'workspace', icon: 'folder', title: 'Workspace Assistant', blurb: 'Mines your local query history for tables to pin, repeated queries worth saving, and error patterns to fix.' },
  { type: 'schema', icon: 'note', title: 'Schema Understanding', blurb: 'Explains what this database does as a whole — the business domain, core entities and how they relate.' }
]

const SEV_RANK: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
const SEV_LABEL: Record<FindingSeverity, string> = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info'
}

async function run(type: InvestigationType): Promise<void> {
  if (type === 'query' && !sql.value.trim()) {
    error.value = 'Paste or load a query to investigate first.'
    activeType.value = 'query'
    return
  }
  activeType.value = type
  running.value = true
  error.value = ''
  report.value = null
  try {
    report.value = await window.api.ai.investigate({
      connectionId: props.connId,
      type,
      sql: type === 'query' ? sql.value.trim() : undefined,
      question: type === 'rootCause' ? question.value.trim() || undefined : undefined
    })
    // Most-severe findings first.
    report.value.findings.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

function scoreColor(s: number): string {
  return s >= 85 ? 'green' : s >= 60 ? 'amber' : 'red'
}

function openTable(name?: string): void {
  if (name) tabsStore.openTable(props.connId, { name, type: 'table' })
}
function copySql(s?: string): void {
  if (s) void navigator.clipboard.writeText(s).catch(() => undefined)
}
function runInEditor(s?: string): void {
  if (!s) return
  const t = tabsStore.openQuery(props.connId)
  t.query = s
}

onMounted(() => {
  void window.api.ai.hasKey().then((r) => (aiReady.value = r))
  applyInit()
})
watch(() => props.init, applyInit)

function applyInit(): void {
  const init = props.init
  if (!init) return
  if (init.type === 'query') {
    if (init.sql) {
      sql.value = init.sql
      void run('query')
    }
  } else if (init.type === 'rootCause') {
    // Highlight the card so the user can type a symptom; only auto-run if one was supplied.
    activeType.value = 'rootCause'
    if (init.question) {
      question.value = init.question
      void run('rootCause')
    }
  } else {
    void run(init.type)
  }
}
</script>

<template>
  <div class="inv">
    <header class="inv-head">
      <div>
        <h1>AI Investigation Suite</h1>
        <p class="sub">An AI database engineer that investigates with live evidence — execution plans, catalogs, statistics and locks. Read-only; every finding is grounded in real data.</p>
      </div>
    </header>

    <div v-if="!aiReady" class="inv-note"><Icon name="settings" :size="13" /> No AI provider configured. Add a key in <strong>Settings → AI</strong> to run investigations.</div>

    <div class="cards">
      <div v-for="c in cards" :key="c.type" class="card" :class="{ active: activeType === c.type }">
        <div class="card-ic"><Icon :name="c.icon" :size="20" /></div>
        <h2>{{ c.title }}</h2>
        <p>{{ c.blurb }}</p>
        <div v-if="c.type === 'query'" class="q-box">
          <textarea aria-label="SQL query to investigate"
            class="q-input"
            v-model="sql"
            spellcheck="false"
            placeholder="Paste a SQL query, or open the Investigations hub from a query's Investigate button…"
          />
        </div>
        <div v-else-if="c.type === 'rootCause'" class="q-box">
          <textarea aria-label="Symptom"
            class="q-input symptom"
            v-model="question"
            spellcheck="false"
            placeholder="Describe the symptom — e.g. “Why did revenue suddenly drop today?” (optional)"
          />
        </div>
        <button class="btn run" :disabled="running || !aiReady" @click="run(c.type)">
          {{ running && activeType === c.type ? 'Investigating…' : 'Investigate' }}
        </button>
      </div>
    </div>

    <section v-if="running || report || error" class="report">
      <div v-if="running" class="state">Gathering evidence and analyzing…</div>
      <div v-else-if="error" class="state err" role="alert">{{ error }}</div>
      <template v-else-if="report">
        <div class="report-top">
          <div v-if="report.score != null" class="score" :class="scoreColor(report.score)">
            <span class="score-num">{{ report.score }}</span><span class="score-den">/100</span>
            <span v-if="report.rating" class="score-rating">{{ report.rating }}</span>
          </div>
          <p class="summary">{{ report.summary }}</p>
        </div>

        <div v-if="report.findings.length" class="findings">
          <article v-for="(f, i) in report.findings" :key="i" class="finding" :class="f.severity">
            <div class="f-head">
              <span class="sev" :class="f.severity">{{ SEV_LABEL[f.severity] }}</span>
              <span class="f-title">{{ f.title }}</span>
              <span v-if="f.estimatedImpact" class="f-impact">{{ f.estimatedImpact }}</span>
            </div>
            <p class="f-detail">{{ f.detail }}</p>
            <pre v-if="f.sql" class="f-sql">{{ f.sql }}</pre>
            <div class="f-actions">
              <button v-if="f.table" class="btn-ghost" @click="openTable(f.table)">Open {{ f.table }}</button>
              <button v-if="f.sql" class="btn-ghost" @click="copySql(f.sql)">Copy SQL</button>
              <button v-if="f.sql" class="btn-ghost" @click="runInEditor(f.sql)">Open in editor</button>
            </div>
          </article>
        </div>
        <p class="disclaimer"><Icon name="warn" :size="12" /> Advisory only — DataDock gathered this read-only and changed nothing. Review every command before running it.</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.inv {
  height: 100%;
  overflow-y: auto;
  padding: 24px 28px 60px;
}
.inv-head h1 {
  font-family: var(--font-display, var(--font));
  font-size: var(--fs-xl);
  font-weight: 700;
  margin: 0 0 6px;
}
.sub {
  color: var(--text-dim);
  font-size: var(--fs-base);
  max-width: 80ch;
  margin: 0;
  line-height: 1.5;
}
.inv-note {
  margin: 16px 0 0;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--warn-soft);
  color: var(--warn-text);
  font-size: var(--fs-base);
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
  margin: 20px 0 8px;
}
.card {
  position: relative;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-elevated);
  padding: 16px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-soft);
}
.card.soon {
  opacity: 0.6;
}
.soon-tag {
  position: absolute;
  top: 12px;
  right: 12px;
  font-size: var(--fs-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  padding: 1px 6px;
}
.card-ic {
  font-size: var(--fs-xl);
}
.card h2 {
  font-size: var(--fs-md);
  font-weight: 600;
  margin: 0;
}
.card p {
  font-size: var(--fs-base);
  color: var(--text-dim);
  line-height: 1.5;
  margin: 0;
  flex: 1;
}
.q-box {
  margin-top: 2px;
}
.q-input {
  width: 100%;
  min-height: 64px;
  resize: vertical;
  font-family: var(--mono);
  font-size: var(--fs-sm);
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  color: var(--text);
  border-radius: 8px;
  padding: 8px 10px;
}
.q-input.symptom {
  font-family: var(--font);
  font-size: var(--fs-base);
  min-height: 52px;
}
.btn.run {
  align-self: flex-start;
  margin-top: 4px;
  font-size: var(--fs-base);
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--accent);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 600;
}
.btn.run:disabled {
  opacity: 0.5;
  cursor: default;
}
.report {
  margin-top: 22px;
  border-top: 1px solid var(--border);
  padding-top: 22px;
}
.state {
  color: var(--text-dim);
  font-size: var(--fs-base);
}
.state.err {
  color: var(--danger-text);
}
.report-top {
  display: flex;
  gap: 18px;
  align-items: flex-start;
}
.score {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 116px;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid var(--border);
}
.score.green { border-color: var(--ok-line); color: var(--ok-text); }
.score.amber { border-color: var(--warn-line); color: var(--warn-text); }
.score.red { border-color: var(--danger-line); color: var(--danger-text); }
.score-num { font-size: var(--fs-3xl); font-weight: 800; line-height: 1; }
.score-den { font-size: var(--fs-sm); color: var(--text-faint); }
.score-rating { margin-top: 6px; font-size: var(--fs-base); font-weight: 700; }
.summary {
  font-size: var(--fs-md);
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
  margin: 2px 0 0;
}
.findings {
  margin-top: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.finding {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg-elevated);
}
.f-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.f-title {
  font-weight: 600;
  font-size: var(--fs-base);
  flex: 1;
}
.f-impact {
  font-size: var(--fs-sm);
  color: var(--text-faint);
  font-family: var(--mono);
}
.sev {
  font-size: var(--fs-xs);
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 5px;
}
.sev.critical { background: var(--danger-soft); color: var(--danger-text); }
.sev.high { background: color-mix(in srgb, var(--hue-orange) 18%, transparent); color: var(--hue-orange); }
.sev.medium { background: var(--warn-soft); color: var(--warn-text); }
.sev.low { background: var(--accent-soft); color: var(--accent-text); }
.sev.info { background: var(--border-strong); color: var(--text); }
.f-detail {
  margin: 8px 0 0;
  font-size: var(--fs-base);
  line-height: 1.55;
  color: var(--text-dim);
  white-space: pre-wrap;
}
.f-sql {
  margin: 10px 0 0;
  padding: 10px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: var(--mono);
  font-size: var(--fs-sm);
  color: var(--syn-string);
  overflow-x: auto;
  white-space: pre-wrap;
}
.f-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.btn-ghost {
  font-size: var(--fs-sm);
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  background: transparent;
}
.btn-ghost:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.disclaimer {
  margin-top: 18px;
  font-size: var(--fs-sm);
  color: var(--text-faint);
}
</style>
