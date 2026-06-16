<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import Modal from './Modal.vue'

const props = defineProps<{ connId: string }>()
const emit = defineEmits<{ open: [name: string]; close: [] }>()

const loading = ref(true)
const error = ref('')
const schema = ref<Record<string, string[]>>({})
const term = ref('')
const inputEl = ref<HTMLInputElement>()

onMounted(async () => {
  try {
    schema.value = await window.api.db.schema(props.connId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    inputEl.value?.focus()
  }
})

interface Match {
  table: string
  column?: string // undefined = the table name itself matched
}

const matches = computed<Match[]>(() => {
  const q = term.value.trim().toLowerCase()
  if (!q) return []
  const out: Match[] = []
  for (const [table, cols] of Object.entries(schema.value)) {
    if (table.toLowerCase().includes(q)) out.push({ table })
    for (const col of cols) {
      if (col.toLowerCase().includes(q)) out.push({ table, column: col })
    }
  }
  return out.slice(0, 200)
})

const totalColumns = computed(() =>
  Object.values(schema.value).reduce((n, c) => n + c.length, 0)
)
</script>

<template>
  <Modal title="Search schema" wide @close="emit('close')">
    <input
      ref="inputEl"
      class="input search"
      v-model="term"
      placeholder="Find a table or column by name…"
    />
    <div v-if="loading" class="state">Loading schema…</div>
    <div v-else-if="error" class="state err">{{ error }}</div>
    <template v-else>
      <p class="hint">
        Searching {{ Object.keys(schema).length }} tables · {{ totalColumns }} columns.
      </p>
      <ul v-if="matches.length" class="results">
        <li v-for="(m, i) in matches" :key="i">
          <button class="row" @click="emit('open', m.table)">
            <span class="tbl">{{ m.table }}</span>
            <template v-if="m.column"><span class="dot">.</span><span class="col">{{ m.column }}</span></template>
            <span class="tag">{{ m.column ? 'column' : 'table' }}</span>
          </button>
        </li>
      </ul>
      <p v-else-if="term.trim()" class="empty">No tables or columns match “{{ term }}”.</p>
    </template>
    <template #footer>
      <button class="btn btn-primary" @click="emit('close')">Done</button>
    </template>
  </Modal>
</template>

<style scoped>
.search {
  width: 100%;
  margin-bottom: 12px;
}
.state {
  color: var(--text-dim);
  font-size: 12.5px;
}
.state.err {
  color: var(--danger);
}
.hint {
  color: var(--text-faint);
  font-size: 11.5px;
  margin-bottom: 10px;
}
.results {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 46vh;
  overflow-y: auto;
}
.row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 12.5px;
  text-align: left;
}
.row:hover {
  background: var(--bg-hover);
}
.tbl {
  color: var(--text);
  font-weight: 600;
}
.dot {
  color: var(--text-faint);
}
.col {
  color: var(--accent);
}
.tag {
  margin-left: auto;
  font-family: var(--font);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}
.empty {
  color: var(--text-faint);
  font-size: 12px;
  font-style: italic;
}
</style>
