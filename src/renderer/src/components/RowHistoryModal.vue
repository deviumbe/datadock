<script setup lang="ts">
import { ref, watch } from 'vue'
import type { RowVersion } from '@shared/types'
import Modal from './Modal.vue'
import Icon from './Icon.vue'

const props = defineProps<{
  connId: string
  table: string
  pk: Record<string, unknown>
  label: string
  canRevert: boolean
}>()
const emit = defineEmits<{ close: []; revert: [values: Record<string, unknown>] }>()

const versions = ref<RowVersion[]>([])
const loading = ref(false)
const error = ref('')

async function reload(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    versions.value = await window.api.rowHistory.list(props.connId, props.table, props.pk)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
watch(() => [props.connId, props.table, props.label], reload, { immediate: true })

/** Columns that actually changed in this version (excluding primary keys). */
function changedCols(v: RowVersion): string[] {
  const before = v.before ?? {}
  const after = v.after ?? {}
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...names].filter(
    (c) => !(c in props.pk) && String(before[c] ?? '') !== String(after[c] ?? '')
  )
}

function display(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (v === '') return '∅'
  return String(v)
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

const OP_LABEL = { update: 'Updated', delete: 'Deleted', insert: 'Inserted' } as const
</script>

<template>
  <Modal title="Row history" wide @close="emit('close')">
    <div class="rh">
      <p class="intro">
        Every change you've made to <code>{{ label }}</code> in DataDock, newest first. Use
        <strong>Restore</strong> to stage the row's earlier values (then ⌘S to save).
        <em>External changes aren't tracked.</em>
      </p>

      <p v-if="error" class="err">{{ error }}</p>
      <div v-if="loading && !versions.length" class="state">Loading…</div>
      <div v-else-if="!versions.length" class="state">
        No recorded history for this row yet. Edits you make here will show up the next time.
      </div>

      <div v-else class="timeline">
        <div v-for="v in versions" :key="v.id" class="ver" :class="v.op">
          <div class="ver-head">
            <span class="op-tag" :class="v.op">{{ OP_LABEL[v.op] }}</span>
            <span class="when">{{ fmtWhen(v.at) }}</span>
            <button
              v-if="v.op === 'update' && v.before && canRevert"
              class="revert"
              title="Stage these earlier values on the live row"
              @click="emit('revert', v.before)"
            >
              <Icon name="swap" :size="12" /> Restore
            </button>
          </div>

          <div v-if="v.op === 'delete'" class="ver-note">Row was deleted.</div>
          <ul v-else class="changes">
            <li v-for="c in changedCols(v)" :key="c" class="change">
              <span class="col">{{ c }}</span>
              <span class="from">{{ display((v.before ?? {})[c]) }}</span>
              <Icon name="chevronRight" :size="11" class="arr" />
              <span class="to">{{ display((v.after ?? {})[c]) }}</span>
            </li>
            <li v-if="!changedCols(v).length" class="change empty">No column changes.</li>
          </ul>
        </div>
      </div>
    </div>

    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Close</button>
    </template>
  </Modal>
</template>

<style scoped>
.rh {
  min-width: 540px;
  max-width: 660px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.intro {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-dim);
}
.intro code {
  font-family: var(--mono);
  color: var(--text);
  background: var(--bg-input);
  padding: 1px 5px;
  border-radius: 4px;
}
.intro strong {
  color: var(--text);
}
.intro em {
  color: var(--text-faint);
  font-style: normal;
}
.err {
  color: var(--danger);
  font-size: 12px;
  font-family: var(--mono);
}
.state {
  font-size: 12.5px;
  color: var(--text-dim);
  padding: 18px;
  text-align: center;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
}
.timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 52vh;
  overflow-y: auto;
}
.ver {
  border: 1px solid var(--border-soft);
  border-left: 3px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  padding: 10px 13px;
}
.ver.update {
  border-left-color: var(--accent);
}
.ver.delete {
  border-left-color: var(--danger);
}
.ver.insert {
  border-left-color: var(--ok);
}
.ver-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 7px;
}
.op-tag {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 7px;
  border-radius: 999px;
  color: var(--accent);
  background: var(--accent-soft);
}
.op-tag.delete {
  color: var(--danger);
  background: rgba(248, 113, 113, 0.14);
}
.op-tag.insert {
  color: var(--ok);
  background: rgba(34, 197, 94, 0.14);
}
.when {
  font-size: 11.5px;
  color: var(--text-faint);
  font-family: var(--mono);
  flex: 1;
}
.revert {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
}
.revert:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.changes {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.change {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-family: var(--mono);
}
.change.empty {
  color: var(--text-faint);
  font-style: italic;
}
.col {
  min-width: 110px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.from {
  color: var(--text-faint);
  text-decoration: line-through;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.to {
  color: var(--text);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.arr {
  color: var(--text-faint);
  flex: none;
}
.ver-note {
  font-size: 12px;
  color: var(--danger);
}
</style>
