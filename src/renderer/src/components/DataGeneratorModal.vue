<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Modal from './Modal.vue'
import type { DriverType, TableInfo } from '@shared/types'
import { GEN_LABELS, genValue, guessGen, type Gen } from '../lib/dataGen'

const props = defineProps<{ connId: string; driver: DriverType; table: TableInfo }>()
const emit = defineEmits<{ close: []; done: [] }>()

interface ColCfg {
  name: string
  type: string
  isPrimaryKey: boolean
  gen: Gen
  fixed: string
}

const count = ref(50)
const cols = ref<ColCfg[]>([])
const busy = ref(false)
const error = ref('')
const message = ref('')
const genKeys = Object.keys(GEN_LABELS) as Gen[]

onMounted(async () => {
  try {
    const s = await window.api.db.tableStructure(props.connId, {
      schema: props.table.schema,
      name: props.table.name,
      type: props.table.type
    })
    cols.value = s.columns.map((c) => ({
      name: c.name,
      type: c.type,
      isPrimaryKey: c.isPrimaryKey,
      gen: guessGen(c.name, c.type, c.isPrimaryKey),
      fixed: ''
    }))
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})

async function generate(): Promise<void> {
  busy.value = true
  error.value = ''
  message.value = ''
  const n = Math.max(1, Math.min(100000, count.value))
  const inserts: Record<string, unknown>[] = []
  for (let i = 0; i < n; i++) {
    const row: Record<string, unknown> = {}
    for (const c of cols.value) {
      if (c.gen === 'none') continue
      const v = genValue(c.gen, i, props.driver, c.fixed)
      if (v !== undefined) row[c.name] = v
    }
    if (Object.keys(row).length) inserts.push(row)
  }
  try {
    await window.api.db.applyChanges(
      props.connId,
      { schema: props.table.schema, name: props.table.name, type: props.table.type },
      { updates: [], inserts, deletes: [] }
    )
    message.value = `Inserted ${inserts.length} rows into ${props.table.name}.`
    emit('done')
    setTimeout(() => emit('close'), 900)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="`Generate data → ${table.name}`" wide @close="emit('close')">
    <div class="row-count">
      <label>Rows to generate</label>
      <input class="input" type="number" v-model.number="count" min="1" max="100000" />
    </div>

    <table class="cols">
      <thead>
        <tr><th>Column</th><th>Type</th><th>Generator</th></tr>
      </thead>
      <tbody>
        <tr v-for="c in cols" :key="c.name">
          <td class="cn">
            {{ c.name }}<span v-if="c.isPrimaryKey" class="pk">PK</span>
          </td>
          <td class="ct">{{ c.type }}</td>
          <td class="cg">
            <select class="select sm" v-model="c.gen">
              <option v-for="g in genKeys" :key="g" :value="g">{{ GEN_LABELS[g] }}</option>
            </select>
            <input v-if="c.gen === 'fixed'" class="input sm fixed" v-model="c.fixed" placeholder="value" />
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="error" class="err">{{ error }}</div>
    <div v-if="message" class="msg">{{ message }}</div>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || cols.length === 0" @click="generate">
        {{ busy ? 'Generating…' : `Generate ${count} rows` }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.row-count {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.row-count label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
}
.row-count .input {
  width: 120px;
}
.cols {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
}
.cols th {
  text-align: left;
  color: var(--text-faint);
  font-weight: 600;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
}
.cols td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.cn {
  font-family: var(--mono);
}
.pk {
  font-size: 8px;
  font-weight: 700;
  background: var(--accent-soft);
  color: var(--accent);
  padding: 1px 4px;
  border-radius: 3px;
  margin-left: 6px;
}
.ct {
  font-family: var(--mono);
  color: var(--text-faint);
}
.cg {
  display: flex;
  gap: 6px;
  align-items: center;
}
.select.sm {
  padding: 4px 7px;
  font-size: 12px;
}
.input.sm.fixed {
  padding: 4px 7px;
  font-size: 12px;
  width: 120px;
}
.err {
  margin-top: 12px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  background: rgba(229, 97, 106, 0.13);
  color: var(--danger);
  font-size: 12px;
  font-family: var(--mono);
}
.msg {
  margin-top: 12px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  background: rgba(63, 207, 142, 0.13);
  color: var(--ok);
  font-size: 12px;
}
</style>
