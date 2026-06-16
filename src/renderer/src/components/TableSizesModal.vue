<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import Modal from './Modal.vue'
import type { TableSizeInfo } from '@shared/types'

const props = defineProps<{ connId: string }>()
const emit = defineEmits<{ open: [name: string]; close: [] }>()

const loading = ref(true)
const error = ref('')
const sizes = ref<TableSizeInfo[]>([])

onMounted(async () => {
  try {
    sizes.value = await window.api.db.tableSizes(props.connId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

const hasBytes = computed(() => sizes.value.some((s) => s.bytes != null))
const maxBytes = computed(() => Math.max(1, ...sizes.value.map((s) => s.bytes ?? 0)))

function fmtBytes(n: number | null): string {
  if (n == null) return '—'
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
function fmtRows(n: number | null): string {
  if (n == null) return '—'
  return n.toLocaleString()
}
</script>

<template>
  <Modal title="Table sizes" wide @close="emit('close')">
    <div v-if="loading" class="state">Measuring tables…</div>
    <div v-else-if="error" class="state err">{{ error }}</div>
    <div v-else-if="!sizes.length" class="state">No tables found.</div>
    <table v-else class="sizes">
      <thead>
        <tr>
          <th>Table</th>
          <th class="num">Rows</th>
          <th v-if="hasBytes" class="size">Size</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in sizes" :key="(s.schema ?? '') + '.' + s.name">
          <td>
            <button class="link" @click="emit('open', s.name)">
              <span v-if="s.schema" class="schema">{{ s.schema }}.</span>{{ s.name }}
            </button>
          </td>
          <td class="num">{{ fmtRows(s.rows) }}</td>
          <td v-if="hasBytes" class="size">
            <div class="bar-wrap">
              <div class="bar" :style="{ width: `${((s.bytes ?? 0) / maxBytes) * 100}%` }" />
              <span class="bar-label">{{ fmtBytes(s.bytes) }}</span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!loading && !error && !hasBytes && sizes.length" class="hint">
      On-disk size isn't available for this engine — showing row counts only.
    </p>
    <template #footer>
      <button class="btn btn-primary" @click="emit('close')">Done</button>
    </template>
  </Modal>
</template>

<style scoped>
.state {
  color: var(--text-dim);
  font-size: 12.5px;
  padding: 8px 0;
}
.state.err {
  color: var(--danger);
}
.sizes {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.sizes th {
  text-align: left;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-strong);
}
.sizes th.num,
.sizes th.size {
  text-align: right;
}
.sizes td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
}
.sizes td.num {
  text-align: right;
  font-family: var(--mono);
  color: var(--text-dim);
  white-space: nowrap;
}
.schema {
  color: var(--text-faint);
}
.link {
  color: var(--accent);
  font-weight: 600;
  font-family: var(--mono);
}
.link:hover {
  text-decoration: underline;
}
.size {
  width: 45%;
}
.bar-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  height: 18px;
}
.bar {
  position: absolute;
  left: 0;
  height: 100%;
  background: var(--accent-soft);
  border-radius: 3px;
}
.bar-label {
  position: relative;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text);
}
.hint {
  color: var(--text-faint);
  font-size: 11.5px;
  margin-top: 12px;
}
</style>
