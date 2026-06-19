<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import Modal from './Modal.vue'
import type { RedisKeyValue } from '@shared/types'

const props = defineProps<{ connId: string; redisKey: string }>()
const emit = defineEmits<{ close: [] }>()

const data = ref<RedisKeyValue | null>(null)
const error = ref('')
const loading = ref(true)

onMounted(async () => {
  try {
    data.value = await window.api.redis.keyValue(props.connId, props.redisKey)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

const stringValue = computed(() => (typeof data.value?.value === 'string' ? data.value.value : ''))
const arrayValue = computed(() => (Array.isArray(data.value?.value) ? (data.value!.value as unknown[]) : []))
const zsetValue = computed(() => arrayValue.value as { member: string; score: number }[])
const hashValue = computed(() => arrayValue.value as { field: string; value: string }[])
const streamValue = computed(() => arrayValue.value as { id: string; fields: string[] }[])

function ttlLabel(ttl: number): string {
  if (ttl === -1) return 'no expiry'
  if (ttl === -2) return 'missing'
  return `${ttl}s`
}
function bytesLabel(b: number | null): string {
  if (b == null) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <Modal :title="redisKey" wide @close="emit('close')">
    <div v-if="loading" class="muted">Loading…</div>
    <div v-else-if="error" class="err">{{ error }}</div>
    <template v-else-if="data">
      <div class="meta">
        <span class="pill type">{{ data.type }}</span>
        <span class="pill">{{ ttlLabel(data.ttl) }}</span>
        <span class="pill">{{ bytesLabel(data.bytes) }}</span>
        <span v-if="data.length != null" class="pill">{{ data.length }} {{ data.type === 'string' ? 'chars' : 'items' }}</span>
      </div>

      <pre v-if="data.type === 'string'" class="val">{{ stringValue }}</pre>

      <table v-else-if="data.type === 'hash'" class="kv">
        <thead><tr><th>field</th><th>value</th></tr></thead>
        <tbody>
          <tr v-for="(h, i) in hashValue" :key="i"><td class="k">{{ h.field }}</td><td>{{ h.value }}</td></tr>
        </tbody>
      </table>

      <table v-else-if="data.type === 'zset'" class="kv">
        <thead><tr><th>member</th><th>score</th></tr></thead>
        <tbody>
          <tr v-for="(z, i) in zsetValue" :key="i"><td>{{ z.member }}</td><td class="k">{{ z.score }}</td></tr>
        </tbody>
      </table>

      <table v-else-if="data.type === 'stream'" class="kv">
        <thead><tr><th>id</th><th>fields</th></tr></thead>
        <tbody>
          <tr v-for="(s, i) in streamValue" :key="i"><td class="k">{{ s.id }}</td><td>{{ s.fields.join(' ') }}</td></tr>
        </tbody>
      </table>

      <ol v-else-if="data.type === 'list'" class="items">
        <li v-for="(it, i) in arrayValue" :key="i">{{ it }}</li>
      </ol>

      <ul v-else-if="data.type === 'set'" class="items">
        <li v-for="(it, i) in arrayValue" :key="i">{{ it }}</li>
      </ul>

      <div v-else class="muted">No value.</div>

      <p v-if="data.truncated" class="trunc">Preview truncated — showing the first elements only.</p>
    </template>
  </Modal>
</template>

<style scoped>
.muted {
  color: var(--text-faint);
  font-size: 13px;
}
.err {
  color: var(--danger);
  font-size: 13px;
}
.meta {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.pill {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
}
.pill.type {
  color: var(--accent);
  border-color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.val {
  margin: 0;
  padding: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 50vh;
  overflow: auto;
}
.kv {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.kv th {
  text-align: left;
  color: var(--text-faint);
  font-weight: 600;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
}
.kv td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  word-break: break-word;
}
.kv td.k {
  font-family: var(--mono);
  color: var(--accent);
}
.items {
  margin: 0;
  padding-left: 24px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  max-height: 50vh;
  overflow: auto;
}
.items li {
  padding: 2px 0;
  word-break: break-word;
}
.trunc {
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-faint);
}
</style>
