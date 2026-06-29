<script setup lang="ts">
import { reactive, computed } from 'vue'
import Modal from './Modal.vue'
import { useWorkspace } from '../stores/workspace'
import type { ConnectionConfig, ReplicationRole, Topology, TopologyNode } from '@shared/types'

const props = defineProps<{ topology?: Topology }>()
const emit = defineEmits<{ save: [topology: Topology]; close: [] }>()

const ws = useWorkspace()

// Engines that actually report replication status; others are allowed but warned.
const REPL_DRIVERS = new Set(['postgres', 'cockroachdb', 'timescaledb', 'redshift', 'mysql', 'mongodb', 'redis'])

const allConnections = computed<ConnectionConfig[]>(() =>
  ws.projects.flatMap((p) => p.environments.flatMap((e) => e.connections))
)

const ROLES: { value: ReplicationRole; label: string }[] = [
  { value: 'primary', label: 'Primary' },
  { value: 'replica', label: 'Replica' },
  { value: 'arbiter', label: 'Arbiter' },
  { value: 'unknown', label: 'Unknown' }
]

const form = reactive<Topology>({
  id: props.topology?.id ?? '',
  name: props.topology?.name ?? '',
  nodes: props.topology?.nodes ? props.topology.nodes.map((n) => ({ ...n })) : [],
  lagWarnSeconds: props.topology?.lagWarnSeconds ?? 1,
  lagCritSeconds: props.topology?.lagCritSeconds ?? 10
})

function connName(id: string): string {
  return allConnections.value.find((c) => c.id === id)?.name ?? '(deleted connection)'
}
function connDriver(id: string): string | undefined {
  return allConnections.value.find((c) => c.id === id)?.driver
}

// Connections not yet in the set, for the "add" dropdown.
const available = computed(() =>
  allConnections.value.filter((c) => !form.nodes.some((n) => n.connectionId === c.id))
)

function addNode(connectionId: string): void {
  if (!connectionId) return
  // First node defaults to primary, the rest to replica.
  const role: ReplicationRole = form.nodes.some((n) => n.role === 'primary') ? 'replica' : 'primary'
  form.nodes.push({ connectionId, role })
}
function removeNode(n: TopologyNode): void {
  form.nodes = form.nodes.filter((x) => x.connectionId !== n.connectionId)
}

const canSave = computed(() => form.name.trim().length > 0 && form.nodes.length > 0)

function save(): void {
  if (!canSave.value) return
  emit('save', {
    ...form,
    name: form.name.trim(),
    lagWarnSeconds: Number(form.lagWarnSeconds) || 1,
    lagCritSeconds: Number(form.lagCritSeconds) || 10
  })
}
</script>

<template>
  <Modal :title="props.topology ? 'Edit Topology' : 'New Topology'" wide @close="emit('close')">
    <div class="te-grid">
      <div class="field span2">
        <label>Name</label>
        <input class="input" v-model="form.name" placeholder="e.g. Production Postgres HA" />
      </div>

      <div class="field">
        <label>Amber lag (seconds)</label>
        <input class="input" type="number" min="0" step="0.5" v-model.number="form.lagWarnSeconds" />
      </div>
      <div class="field">
        <label>Red lag (seconds)</label>
        <input class="input" type="number" min="0" step="1" v-model.number="form.lagCritSeconds" />
      </div>

      <div class="field span2">
        <label>Members</label>
        <div v-if="!form.nodes.length" class="te-empty">No members yet — add connections below.</div>
        <div v-for="n in form.nodes" :key="n.connectionId" class="te-node">
          <span class="te-driver">{{ (connDriver(n.connectionId) || '?').toUpperCase().slice(0, 4) }}</span>
          <span class="te-name" :title="connName(n.connectionId)">{{ connName(n.connectionId) }}</span>
          <span v-if="connDriver(n.connectionId) && !REPL_DRIVERS.has(connDriver(n.connectionId)!)" class="te-warn" title="This engine doesn't report replication status">no repl</span>
          <select class="select te-role" v-model="n.role">
            <option v-for="r in ROLES" :key="r.value" :value="r.value">{{ r.label }}</option>
          </select>
          <button class="btn-ghost icon danger" title="Remove" @click="removeNode(n)">✕</button>
        </div>

        <div v-if="available.length" class="te-add">
          <select class="select" @change="addNode(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
            <option value="">+ Add connection…</option>
            <option v-for="c in available" :key="c.id" :value="c.id">{{ c.name }} ({{ c.driver }})</option>
          </select>
        </div>
      </div>
    </div>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canSave" @click="save">Save</button>
    </template>
  </Modal>
</template>

<style scoped>
.te-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.span2 {
  grid-column: 1 / 3;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field label {
  font-size: 11.5px;
  color: var(--text-dim);
}
.te-node {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 6px;
  background: var(--bg-elevated);
}
.te-driver {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 2px 5px;
}
.te-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
}
.te-warn {
  font-size: 10px;
  color: var(--warn);
  border: 1px solid var(--warn);
  border-radius: 4px;
  padding: 1px 5px;
}
.te-role {
  width: 120px;
}
.te-add {
  margin-top: 4px;
}
.te-empty {
  color: var(--text-faint);
  font-size: 12.5px;
  padding: 4px 0 8px;
}
</style>
