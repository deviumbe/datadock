<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import Modal from './Modal.vue'
import { useWorkspace } from '../stores/workspace'
import type { DbObject, DbObjectKind } from '@shared/types'

const props = defineProps<{ connId: string }>()
const emit = defineEmits<{ close: []; done: [dropped: number] }>()

const ws = useWorkspace()
const conn = computed(() => ws.findConnection(props.connId))

const KIND_ORDER: DbObjectKind[] = [
  'table', 'view', 'materialized view', 'sequence', 'procedure', 'function', 'event', 'type', 'domain'
]
const PLURAL: Record<DbObjectKind, string> = {
  table: 'tables',
  view: 'views',
  'materialized view': 'materialized views',
  sequence: 'sequences',
  procedure: 'procedures',
  function: 'functions',
  event: 'events',
  type: 'types',
  domain: 'domains'
}

const loading = ref(true)
const busy = ref(false)
const error = ref('')
const database = ref('')
const objects = ref<DbObject[]>([])
const confirmText = ref('')
const expanded = ref<DbObjectKind | null>(null)

const groups = computed(() =>
  KIND_ORDER.map((kind) => ({ kind, items: objects.value.filter((o) => o.kind === kind) })).filter(
    (g) => g.items.length
  )
)
const showSchema = computed(() => new Set(objects.value.map((o) => o.schema)).size > 1)
const confirmed = computed(() => !!database.value && confirmText.value.trim() === database.value)

function label(kind: DbObjectKind, n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? kind : PLURAL[kind]}`
}
function objectName(o: DbObject): string {
  const base = showSchema.value && o.schema ? `${o.schema}.${o.name}` : o.name
  return o.args !== undefined ? `${base}(${o.args})` : base
}

onMounted(async () => {
  try {
    const inv = await window.api.db.listAllObjects(props.connId)
    database.value = inv.database
    objects.value = inv.objects
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

async function run(): Promise<void> {
  if (!confirmed.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const dropped = await window.api.db.dropAllObjects(props.connId)
    emit('done', dropped)
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="database ? `Drop all objects in ${database}` : 'Drop all objects'" :busy="busy" @close="emit('close')">
    <p class="intro">
      Drops every table, view and routine in this database — structure and data. Foreign keys
      are ignored. The database itself, its users and permissions are kept.
      To only remove rows, use <strong>Truncate</strong> instead.
    </p>

    <div v-if="conn?.production" class="prod">
      <strong>{{ conn.name }}</strong> is marked as a production connection.
    </div>

    <div v-if="loading" class="muted">Reading the database catalog…</div>
    <div v-else-if="!error && !objects.length" class="muted">This database has no objects to drop.</div>
    <div v-else-if="objects.length" class="inventory">
      <div v-for="g in groups" :key="g.kind" class="group">
        <button class="ghead" @click="expanded = expanded === g.kind ? null : g.kind">
          <span class="caret" :class="{ open: expanded === g.kind }">›</span>
          {{ label(g.kind, g.items.length) }}
        </button>
        <div v-if="expanded === g.kind" class="names">
          <div v-for="o in g.items" :key="objectName(o)" class="name">{{ objectName(o) }}</div>
        </div>
      </div>
    </div>

    <template v-if="objects.length">
      <label class="confirm-lbl">
        Type <code>{{ database }}</code> to confirm
      </label>
      <input
        v-model="confirmText" aria-label="Type the name to confirm"
        class="input"
        spellcheck="false"
        autocomplete="off"
        :disabled="busy"
        @keydown.enter="run"
      />
      <p class="warn">This cannot be undone.</p>
    </template>

    <div v-if="error" class="error" role="alert">{{ error }}</div>

    <template #footer>
      <button class="btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <button v-if="objects.length" class="btn drop-go" :disabled="!confirmed || busy" @click="run">
        {{ busy ? 'Dropping…' : `Drop ${objects.length.toLocaleString()} objects` }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.intro {
  font-size: var(--fs-base);
  color: var(--text-dim);
  line-height: 1.55;
  margin-bottom: 14px;
}
.prod {
  margin-bottom: 14px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--danger);
  color: var(--danger-text);
  font-size: var(--fs-sm);
}
.muted {
  font-size: var(--fs-sm);
  color: var(--text-faint);
  margin-bottom: 14px;
}
.inventory {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 16px;
  max-height: 260px;
  overflow-y: auto;
}
.group + .group {
  border-top: 1px solid var(--border);
}
.ghead {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 11px;
  background: none;
  border: none;
  color: var(--text);
  font-size: var(--fs-base);
  text-align: left;
  cursor: pointer;
}
.ghead:hover {
  background: var(--bg-hover);
}
.caret {
  display: inline-block;
  width: 10px;
  color: var(--text-faint);
  transition: transform var(--dur-1);
}
.caret.open {
  transform: rotate(90deg);
}
.names {
  padding: 2px 11px 9px 29px;
}
.name {
  font-family: var(--mono);
  font-size: var(--fs-sm);
  color: var(--text-dim);
  padding: 1px 0;
  word-break: break-all;
}
.confirm-lbl {
  display: block;
  font-size: var(--fs-sm);
  color: var(--text-dim);
  margin-bottom: 6px;
}
.confirm-lbl code {
  font-family: var(--mono);
  color: var(--text);
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
}
.input {
  width: 100%;
  font-family: var(--mono);
}
.warn {
  margin-top: 10px;
  font-size: var(--fs-sm);
  color: var(--danger-text);
}
.error {
  margin-top: 12px;
  font-size: var(--fs-sm);
  color: var(--danger-text);
  font-family: var(--mono);
  word-break: break-word;
}
.drop-go {
  background: var(--danger);
  border-color: var(--danger);
  color: var(--on-danger);
  font-weight: 600;
}
.drop-go:hover:not(:disabled) {
  background: var(--danger-hover);
}
.drop-go:disabled {
  opacity: 0.5;
}
</style>
