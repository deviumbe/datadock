<script setup lang="ts">
import { ref, computed } from 'vue'
import { diffSchemas, type TableDiff } from '../lib/schemaDiff'

const props = defineProps<{
  connId: string
  connName: string
  candidates: { id: string; label: string }[]
}>()

const targetId = ref('')
const targetLabel = ref('')
const busy = ref(false)
const error = ref('')
const diff = ref<TableDiff[] | null>(null)
const onlyChanges = ref(true)
const expanded = ref<Set<string>>(new Set())

const counts = computed(() => {
  const c = { onlyA: 0, onlyB: 0, changed: 0, same: 0 }
  for (const t of diff.value ?? []) c[t.status]++
  return c
})
const visible = computed(() =>
  (diff.value ?? []).filter((t) => (onlyChanges.value ? t.status !== 'same' : true))
)

async function run(): Promise<void> {
  if (!targetId.value) return
  busy.value = true
  error.value = ''
  diff.value = null
  try {
    await window.api.db.connect(targetId.value) // ensure target is connected
    const [a, b] = await Promise.all([
      window.api.db.schemaSnapshot(props.connId),
      window.api.db.schemaSnapshot(targetId.value)
    ])
    diff.value = diffSchemas(a, b)
    targetLabel.value = props.candidates.find((c) => c.id === targetId.value)?.label ?? 'target'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
function toggle(name: string): void {
  expanded.value.has(name) ? expanded.value.delete(name) : expanded.value.add(name)
}
const badge = (s: TableDiff['status']): string =>
  ({ onlyA: 'only here', onlyB: 'only in target', changed: 'changed', same: 'identical' })[s]
</script>

<template>
  <div class="diff">
    <div class="toolbar">
      <strong>Schema Diff</strong>
      <span class="muted">{{ connName }}</span>
      <span class="arrow">↔</span>
      <select class="select" v-model="targetId" :disabled="busy">
        <option value="" disabled>Compare with…</option>
        <option v-for="c in candidates" :key="c.id" :value="c.id">{{ c.label }}</option>
      </select>
      <button class="btn btn-primary" :disabled="!targetId || busy" @click="run">
        {{ busy ? 'Comparing…' : 'Compare' }}
      </button>
      <div class="spacer" />
      <label v-if="diff" class="chk"><input type="checkbox" v-model="onlyChanges" /> Only differences</label>
    </div>

    <div v-if="error" class="err">{{ error }}</div>

    <div v-if="!diff && !busy && !error" class="empty">
      Pick another connection to compare schemas. (“{{ connName }}” on the left, target on the right.)
    </div>

    <div v-if="diff" class="summary">
      <span class="s same">{{ counts.same }} identical</span>
      <span class="s changed">{{ counts.changed }} changed</span>
      <span class="s onlyA">{{ counts.onlyA }} only in {{ connName }}</span>
      <span class="s onlyB">{{ counts.onlyB }} only in target</span>
    </div>

    <div v-if="diff" class="list">
      <div v-for="t in visible" :key="t.name" class="trow">
        <div class="thead" :class="t.status" @click="toggle(t.name)">
          <span class="caret">{{ expanded.has(t.name) ? '▾' : '▸' }}</span>
          <span class="tname">{{ t.name }}</span>
          <span class="tbadge" :class="t.status">{{ badge(t.status) }}</span>
        </div>
        <div v-if="expanded.has(t.name)" class="cols">
          <div v-for="c in t.columns" :key="c.name" class="crow" :class="c.status">
            <span class="cmark">{{ c.status === 'added' ? '+' : c.status === 'removed' ? '−' : c.status === 'changed' ? '~' : '' }}</span>
            <span class="cname">{{ c.name }}</span>
            <span class="cdetail">
              <template v-if="c.status === 'changed'">{{ c.detail }}</template>
              <template v-else-if="c.status === 'added'">{{ c.b?.type }}</template>
              <template v-else-if="c.status === 'removed'">{{ c.a?.type }}</template>
              <template v-else>{{ c.a?.type }}</template>
            </span>
          </div>
        </div>
      </div>
      <div v-if="visible.length === 0" class="empty">No differences. 🎉</div>
    </div>
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
  max-width: 320px;
}
.spacer {
  flex: 1;
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
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
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  flex-shrink: 0;
}
.summary .changed {
  color: var(--warn);
}
.summary .onlyA {
  color: var(--danger);
}
.summary .onlyB {
  color: var(--ok);
}
.summary .same {
  color: var(--text-faint);
}
.list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
}
.thead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.thead:hover {
  background: var(--bg-hover);
}
.caret {
  color: var(--text-faint);
  font-size: 10px;
  width: 12px;
}
.tname {
  flex: 1;
  font-family: var(--mono);
  font-size: 12px;
}
.tbadge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 10px;
}
.tbadge.changed {
  background: rgba(224, 161, 74, 0.18);
  color: var(--warn);
}
.tbadge.onlyA {
  background: rgba(229, 97, 106, 0.16);
  color: var(--danger);
}
.tbadge.onlyB {
  background: rgba(63, 207, 142, 0.16);
  color: var(--ok);
}
.tbadge.same {
  background: var(--bg-elevated);
  color: var(--text-faint);
}
.cols {
  padding: 2px 0 8px 30px;
}
.crow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  font-family: var(--mono);
  font-size: 12px;
}
.crow.added {
  color: var(--ok);
}
.crow.removed {
  color: var(--danger);
}
.crow.changed {
  color: var(--warn);
}
.crow.same {
  color: var(--text-faint);
}
.cmark {
  width: 12px;
  text-align: center;
  font-weight: 700;
}
.cname {
  min-width: 140px;
}
.cdetail {
  color: var(--text-dim);
}
</style>
