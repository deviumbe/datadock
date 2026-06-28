<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { isSqlDriver, type Snapshot } from '@shared/types'
import Modal from './Modal.vue'
import Icon from './Icon.vue'

const props = defineProps<{ connId: string; connName: string; driver: string; readOnly: boolean }>()
const emit = defineEmits<{ close: []; restored: [] }>()

const isSql = computed(() => isSqlDriver(props.driver))

const list = ref<Snapshot[]>([])
const loading = ref(false)
const label = ref('')
const creating = ref(false)
const error = ref('')

// Restore is destructive, so it's gated behind a per-row "armed" state where the
// user must type the connection name to enable the replace button.
const armed = ref('') // snapshot id currently armed for restore
const confirmText = ref('')
const restoring = ref('')
const result = ref<{ id: string; statements: number; errors: string[] } | null>(null)

async function reload(): Promise<void> {
  if (!isSql.value) return
  loading.value = true
  try {
    list.value = await window.api.snapshots.list(props.connId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
watch(() => props.connId, reload, { immediate: true })

async function take(): Promise<void> {
  if (creating.value || !isSql.value) return
  creating.value = true
  error.value = ''
  try {
    await window.api.snapshots.create(props.connId, label.value)
    label.value = ''
    await reload()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    creating.value = false
  }
}

function arm(id: string): void {
  armed.value = id
  confirmText.value = ''
  result.value = null
}
function disarm(): void {
  armed.value = ''
  confirmText.value = ''
}

async function restore(s: Snapshot): Promise<void> {
  if (confirmText.value.trim() !== props.connName || restoring.value) return
  restoring.value = s.id
  error.value = ''
  try {
    const r = await window.api.snapshots.restore(props.connId, s.id)
    result.value = { id: s.id, ...r }
    disarm()
    emit('restored')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    restoring.value = ''
  }
}

async function remove(s: Snapshot): Promise<void> {
  if (!confirm(`Delete snapshot “${s.label}”? The restore point will be gone for good.`)) return
  try {
    await window.api.snapshots.remove(props.connId, s.id)
    await reload()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<template>
  <Modal title="Database snapshots" wide @close="emit('close')">
    <div class="snap">
      <p class="intro">
        A snapshot is a complete copy of every table's structure and data — a <strong>restore point</strong> you
        can take before a risky change and roll back to if something goes wrong.
      </p>

      <div v-if="!isSql" class="state">Snapshots are available for SQL databases only.</div>

      <template v-else>
        <!-- Take a new snapshot -->
        <div class="take">
          <input
            v-model="label"
            class="input"
            placeholder="Label (e.g. “before migration”)"
            @keydown.enter="take"
          />
          <button class="btn btn-primary" :disabled="creating" @click="take">
            <Icon name="plus" :size="13" /> {{ creating ? 'Saving…' : 'Take snapshot' }}
          </button>
        </div>

        <p v-if="error" class="err">{{ error }}</p>

        <!-- Existing snapshots -->
        <div v-if="loading && !list.length" class="state">Loading…</div>
        <div v-else-if="!list.length" class="empty">
          No snapshots yet. Take one above before making changes you might want to undo.
        </div>
        <div v-else class="list">
          <div v-for="s in list" :key="s.id" class="snap-row" :class="{ armed: armed === s.id }">
            <div class="snap-main">
              <Icon name="database" :size="15" />
              <div class="snap-info">
                <span class="snap-label">{{ s.label }}</span>
                <span class="snap-meta">{{ fmtWhen(s.createdAt) }} · {{ s.tableCount }} tables · {{ fmtSize(s.sizeBytes) }}</span>
              </div>
              <div class="snap-actions">
                <button
                  class="btn btn-ghost restore-btn"
                  :disabled="readOnly"
                  :title="readOnly ? 'Connection is read-only' : 'Replace the database with this snapshot'"
                  @click="arm(s.id)"
                >Restore</button>
                <button class="ic" title="Delete snapshot" @click="remove(s)"><Icon name="trash" :size="15" /></button>
              </div>
            </div>

            <!-- Result of a restore -->
            <div v-if="result && result.id === s.id" class="snap-result" :class="{ bad: result.errors.length }">
              <Icon :name="result.errors.length ? 'warn' : 'check'" :size="13" />
              <span v-if="!result.errors.length">Restored — {{ result.statements }} statements ran cleanly.</span>
              <span v-else>{{ result.statements }} statements ran, {{ result.errors.length }} failed: {{ result.errors[0] }}</span>
            </div>

            <!-- Armed (type-to-confirm) restore -->
            <div v-if="armed === s.id" class="snap-confirm">
              <p class="warn-text">
                <Icon name="warn" :size="14" />
                This <strong>drops and rebuilds every table</strong> from this snapshot. Anything changed since {{ fmtWhen(s.createdAt) }} will be lost.
                Type the connection name <code>{{ connName }}</code> to confirm.
              </p>
              <div class="confirm-row">
                <input v-model="confirmText" class="input" :placeholder="connName" @keydown.enter="restore(s)" />
                <button class="btn btn-ghost" @click="disarm">Cancel</button>
                <button
                  class="btn btn-danger-solid"
                  :disabled="confirmText.trim() !== connName || restoring === s.id"
                  @click="restore(s)"
                >{{ restoring === s.id ? 'Restoring…' : 'Replace database' }}</button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Close</button>
    </template>
  </Modal>
</template>

<style scoped>
.snap {
  min-width: 540px;
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.intro {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-dim);
}
.intro strong {
  color: var(--text);
}
.state,
.empty {
  font-size: 12.5px;
  color: var(--text-dim);
  padding: 16px;
  text-align: center;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
}
.take {
  display: flex;
  gap: 8px;
}
.take .input {
  flex: 1;
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
  max-height: 46vh;
  overflow-y: auto;
}
.snap-row {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  overflow: hidden;
}
.snap-row.armed {
  border-color: var(--danger);
}
.snap-main {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 14px;
  color: var(--accent);
}
.snap-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.snap-label {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.snap-meta {
  font-size: 11px;
  color: var(--text-faint);
  font-family: var(--mono);
}
.snap-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.restore-btn {
  padding: 4px 12px;
  border-radius: 999px;
}
.ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--text-faint);
}
.ic:hover {
  background: rgba(248, 113, 113, 0.15);
  color: var(--danger);
}
.snap-confirm {
  padding: 12px 14px;
  border-top: 1px solid var(--border-soft);
  background: rgba(248, 113, 113, 0.07);
}
.warn-text {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
  margin-bottom: 10px;
}
.warn-text :deep(.dd-icon) {
  margin-top: 1px;
  flex: none;
  color: var(--danger);
}
.warn-text strong {
  color: var(--danger);
}
.warn-text code {
  font-family: var(--mono);
  color: var(--text);
  background: var(--bg-input);
  padding: 1px 5px;
  border-radius: 4px;
}
.confirm-row {
  display: flex;
  gap: 8px;
}
.confirm-row .input {
  flex: 1;
}
.btn-danger-solid {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
  font-weight: 600;
}
.btn-danger-solid:disabled {
  opacity: 0.5;
}
.snap-result {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 14px;
  border-top: 1px solid var(--border-soft);
  font-size: 12px;
  color: var(--ok);
}
.snap-result.bad {
  color: var(--warn);
}
</style>
