<script setup lang="ts">
import Icon from './Icon.vue'
import { ref, computed, useId } from 'vue'
import Modal from './Modal.vue'
import { COLUMN_TYPES, type DriverType, type NewColumn } from '@shared/types'

const uid = useId()

const props = defineProps<{ connId: string; driver: DriverType }>()
const emit = defineEmits<{ close: []; created: [] }>()

const types = computed(() => COLUMN_TYPES[props.driver] ?? [])
const defaultType = computed(() => types.value[0] ?? 'text')

function blankColumn(): NewColumn {
  return { name: '', type: defaultType.value, nullable: true, primaryKey: false, default: '' }
}

const name = ref('')
const columns = ref<NewColumn[]>([
  {
    name: 'id',
    type: COLUMN_TYPES[props.driver]?.find((t) => /^(serial|integer|int|INTEGER)$/.test(t)) ?? 'integer',
    nullable: false,
    primaryKey: true,
    default: ''
  },
  blankColumn()
])
const busy = ref(false)
const error = ref('')

function addColumn(): void {
  columns.value.push(blankColumn())
}
function removeColumn(i: number): void {
  columns.value.splice(i, 1)
}

const canCreate = computed(
  () => name.value.trim() !== '' && columns.value.some((c) => c.name.trim() !== '')
)

async function create(): Promise<void> {
  busy.value = true
  error.value = ''
  const cols = columns.value
    .filter((c) => c.name.trim())
    .map((c) => ({
      name: c.name.trim(),
      type: c.type.trim() || 'text',
      nullable: c.nullable,
      primaryKey: c.primaryKey,
      default: c.default?.trim() || undefined
    }))
  try {
    await window.api.db.createTable(props.connId, { name: name.value.trim(), columns: cols })
    emit('created')
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="New table" wide @close="emit('close')">
    <div class="field">
      <label :for="`${uid}-table-name`">Table name</label>
      <input :id="`${uid}-table-name`" class="input" v-model="name" placeholder="e.g. customers" autofocus />
    </div>

    <div class="cols-head">Columns</div>
    <table class="cols">
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th class="c">Null</th>
          <th class="c">PK</th>
          <th>Default</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(c, i) in columns" :key="i">
          <td><input aria-label="column" class="input sm" v-model="c.name" placeholder="column" /></td>
          <td>
            <select class="select sm" aria-label="Column type" v-model="c.type">
              <option v-for="ty in types" :key="ty" :value="ty">{{ ty }}</option>
            </select>
          </td>
          <td class="c"><input type="checkbox" v-model="c.nullable" aria-label="Nullable" /></td>
          <td class="c"><input type="checkbox" v-model="c.primaryKey" aria-label="Primary key" /></td>
          <td><input aria-label="Default value" class="input sm" v-model="c.default" placeholder="optional" /></td>
          <td class="c">
            <button class="drop" title="Remove column" :disabled="columns.length <= 1" @click="removeColumn(i)"><Icon name="x" :size="12" /></button>
          </td>
        </tr>
      </tbody>
    </table>
    <button class="btn btn-ghost add" @click="addColumn"><Icon name="plus" :size="13" /> Add column</button>

    <div v-if="error" class="err" role="alert">{{ error }}</div>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !canCreate" @click="create">
        {{ busy ? 'Creating…' : 'Create table' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.cols-head {
  margin: 16px 0 8px;
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  font-weight: 600;
}
.cols {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--fs-sm);
}
.cols th {
  text-align: left;
  color: var(--text-faint);
  font-weight: 600;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
}
.cols th.c {
  text-align: center;
  width: 42px;
}
.cols td {
  padding: 4px 6px;
  vertical-align: middle;
}
.cols td.c {
  text-align: center;
}
.input.sm,
.select.sm {
  padding: 4px 7px;
  font-size: var(--fs-sm);
  width: 100%;
}
.add {
  margin-top: 10px;
  padding: 5px 10px;
}
.drop {
  color: var(--danger-text);
  width: 22px;
  height: 22px;
  border-radius: 4px;
}
.drop:hover:not(:disabled) {
  background: var(--danger-soft);
}
.drop:disabled {
  opacity: 0.3;
}
.err {
  margin-top: 12px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger-text);
  font-size: var(--fs-sm);
  font-family: var(--mono);
}
</style>
