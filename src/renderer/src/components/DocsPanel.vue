<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { buildMarkdown, slug, type DocModel, type DocTable, type DocColumn } from '../lib/docs'
import { fmtBytes } from '../lib/perf'
import { isSqlDriver } from '@shared/types'
import Icon from './Icon.vue'

const props = defineProps<{ connId: string; connName: string; driver: string }>()

const isSql = computed(() => isSqlDriver(props.driver))

const loading = ref(false)
const progress = ref(0)
const total = ref(0)
const error = ref('')
const model = ref<DocModel | null>(null)
const copied = ref(false)

const markdown = computed(() => (model.value ? buildMarkdown(model.value) : ''))

// AI: write a one-line purpose description for every table.
const aiBusy = ref(false)
const aiHasKey = ref(false)
window.api.ai.hasKey().then((v) => (aiHasKey.value = v)).catch(() => (aiHasKey.value = false))

async function describeAi(): Promise<void> {
  if (!model.value || aiBusy.value) return
  aiBusy.value = true
  error.value = ''
  try {
    const descs = await window.api.ai.describeSchema({
      driver: props.driver,
      tables: model.value.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name) }))
    })
    model.value = {
      ...model.value,
      tables: model.value.tables.map((t) => ({ ...t, description: descs[t.name] ?? t.description }))
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    aiBusy.value = false
  }
}

async function generate(): Promise<void> {
  if (!isSql.value) return
  loading.value = true
  error.value = ''
  model.value = null
  progress.value = 0
  try {
    const tables = await window.api.db.listTables(props.connId)
    const realTables = tables.filter((t) => t.type === 'table')
    total.value = realTables.length
    const sizes = await window.api.db.tableSizes(props.connId).catch(() => [])
    const sizeMap = new Map(sizes.map((s) => [s.name, s]))

    const docTables: DocTable[] = []
    for (const t of realTables) {
      try {
        const st = await window.api.db.tableStructure(props.connId, t)
        const fkByCol = new Map(st.foreignKeys.map((f) => [f.column, `${f.refTable}.${f.refColumn}`]))
        const columns: DocColumn[] = st.columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          default: c.default,
          isPrimaryKey: c.isPrimaryKey,
          fk: fkByCol.get(c.name)
        }))
        const size = sizeMap.get(t.name)
        docTables.push({
          name: t.name,
          schema: t.schema,
          columns,
          foreignKeys: st.foreignKeys,
          indexes: st.indexes,
          rows: size?.rows ?? null,
          bytes: size?.bytes ?? null
        })
      } catch {
        /* skip a table we can't introspect */
      }
      progress.value++
    }
    model.value = {
      connName: props.connName,
      driver: props.driver,
      generatedAt: new Date().toISOString(),
      tables: docTables,
      totalBytes: docTables.reduce((a, t) => a + (t.bytes ?? 0), 0)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(() => props.connId, generate, { immediate: true })

async function copyMd(): Promise<void> {
  await navigator.clipboard.writeText(markdown.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

async function exportMd(): Promise<void> {
  const name = `${slug(props.connName) || 'database'}-docs.md`
  await window.api.io.saveFile(name, markdown.value, false)
}

function keyOf(c: DocColumn): string {
  return c.isPrimaryKey ? 'PK' : c.fk ? 'FK' : ''
}
</script>

<template>
  <div class="docs">
    <header class="docs-head">
      <div>
        <h2>Documentation</h2>
        <span class="sub" v-if="model">{{ model.tables.length }} tables · {{ model.totalBytes ? fmtBytes(model.totalBytes) : '—' }}</span>
      </div>
      <div class="spacer" />
      <button
        v-if="aiHasKey"
        class="btn btn-ghost ai-describe"
        :disabled="loading || aiBusy || !model"
        title="Let AI write a one-line purpose for every table"
        @click="describeAi"
      >
        <Icon name="sparkles" :size="13" /> {{ aiBusy ? 'Describing…' : 'Describe with AI' }}
      </button>
      <button class="btn btn-ghost" :disabled="loading || !model" @click="copyMd">
        {{ copied ? '✓ Copied' : '⧉ Copy Markdown' }}
      </button>
      <button class="btn btn-primary" :disabled="loading || !model" @click="exportMd">⤓ Export .md</button>
      <button class="btn btn-ghost" :disabled="loading" @click="generate" title="Regenerate">⟳</button>
    </header>

    <div v-if="!isSql" class="state">Documentation generation isn't available for {{ driver }}.</div>
    <div v-else-if="loading" class="state">
      Introspecting schema… {{ progress }}<span v-if="total">/{{ total }}</span> tables
      <div class="pbar"><div class="pfill" :style="{ width: total ? (progress / total) * 100 + '%' : '0%' }" /></div>
    </div>
    <div v-else-if="error" class="state err">{{ error }}</div>
    <div v-else-if="model && !model.tables.length" class="state">No tables to document.</div>

    <div v-else-if="model" class="doc-body">
      <!-- generated overview -->
      <div class="doc-title">
        <h1>{{ model.connName }}</h1>
        <p class="gen">Generated {{ new Date(model.generatedAt).toLocaleString() }} · {{ driver }}</p>
      </div>

      <nav class="toc">
        <a v-for="t in model.tables" :key="t.name" :href="`#tbl-${slug(t.name)}`" class="toc-link">
          {{ t.name }}
          <span v-if="t.rows != null" class="toc-rows">{{ t.rows.toLocaleString() }}</span>
        </a>
      </nav>

      <section v-for="t in model.tables" :key="t.name" :id="`tbl-${slug(t.name)}`" class="tbl">
        <div class="tbl-head">
          <h3>{{ t.name }}</h3>
          <span class="tbl-meta">
            <template v-if="t.rows != null">{{ t.rows.toLocaleString() }} rows</template>
            <template v-if="t.bytes != null"> · {{ fmtBytes(t.bytes) }}</template>
          </span>
        </div>
        <p v-if="t.description" class="tbl-desc"><Icon name="sparkles" :size="12" /> {{ t.description }}</p>

        <table class="cols">
          <thead>
            <tr><th>Column</th><th>Type</th><th>Null</th><th>Key</th><th>Default</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in t.columns" :key="c.name">
              <td class="cmono">{{ c.name }}</td>
              <td class="ctype">{{ c.type }}</td>
              <td class="cnull">{{ c.nullable ? 'YES' : 'NO' }}</td>
              <td><span v-if="keyOf(c)" class="kbadge" :class="keyOf(c).toLowerCase()">{{ keyOf(c) }}</span></td>
              <td class="cmono dim">{{ c.default ?? '' }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="t.foreignKeys.length" class="meta-list">
          <span class="ml-title">Foreign keys</span>
          <span v-for="fk in t.foreignKeys" :key="fk.name" class="chip">
            {{ fk.column }} → {{ fk.refTable }}.{{ fk.refColumn }}
          </span>
        </div>
        <div v-if="t.indexes.length" class="meta-list">
          <span class="ml-title">Indexes</span>
          <span v-for="idx in t.indexes" :key="idx.name" class="chip" :class="{ uniq: idx.unique }">
            {{ idx.name }} ({{ idx.columns.join(', ') }}){{ idx.unique ? ' · unique' : '' }}
          </span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.docs {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
  overflow: hidden;
}
.docs-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.docs-head h2 {
  font-size: 15px;
}
.sub {
  font-size: 12px;
  color: var(--text-faint);
}
.spacer {
  flex: 1;
}
.state {
  margin: auto;
  padding: 50px 20px;
  text-align: center;
  color: var(--text-dim);
  font-size: 13px;
  max-width: 420px;
}
.state.err {
  color: var(--danger);
}
.pbar {
  margin-top: 12px;
  height: 6px;
  background: var(--bg-elevated);
  border-radius: 3px;
  overflow: hidden;
}
.pfill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}
.doc-body {
  flex: 1;
  overflow-y: auto;
  padding: 22px 28px 50px;
  max-width: 920px;
  width: 100%;
  margin: 0 auto;
}
.doc-title h1 {
  font-size: 24px;
}
.gen {
  font-size: 12px;
  color: var(--text-faint);
  margin-top: 4px;
}
.toc {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 18px 0 26px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
.toc-link {
  font-size: 12px;
  color: var(--text-dim);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.toc-link:hover {
  border-color: var(--accent);
  color: var(--text);
}
.toc-rows {
  font-size: 10px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.tbl {
  margin-bottom: 30px;
  scroll-margin-top: 12px;
}
.tbl-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
.tbl-head h3 {
  font-size: 17px;
  color: var(--text);
}
.tbl-meta {
  font-size: 12px;
  color: var(--text-faint);
}
.tbl-desc {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 0 10px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-dim);
}
.tbl-desc :deep(.dd-icon) {
  margin-top: 2px;
  flex: none;
  color: var(--accent);
}
.ai-describe {
  color: var(--accent);
}
.ai-describe:hover {
  background: var(--accent-soft);
}
.cols {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  font-size: 12.5px;
}
.cols th {
  text-align: left;
  background: var(--bg-panel);
  color: var(--text-faint);
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
}
.cols td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
}
.cols tr:last-child td {
  border-bottom: none;
}
.cmono {
  font-family: var(--mono);
}
.ctype {
  color: var(--text-dim);
}
.cnull {
  color: var(--text-faint);
}
.dim {
  color: var(--text-faint);
}
.kbadge {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent);
}
.kbadge.fk {
  background: rgba(176, 122, 214, 0.18);
  color: #b07ad6;
}
.meta-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.ml-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
  margin-right: 2px;
}
.chip {
  font-size: 11.5px;
  font-family: var(--mono);
  color: var(--text-dim);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
}
.chip.uniq {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
