<script setup lang="ts">
import { ref, watch } from 'vue'
import type { AlterOp, ColumnDef, TableStructure } from '@shared/types'

const props = defineProps<{
  structure: TableStructure | null
  tables: string[]
  busy: boolean
}>()
const emit = defineEmits<{ alter: [op: AlterOp] }>()

// Editable copy of columns, re-synced whenever the structure reloads.
const cols = ref<ColumnDef[]>([])
watch(
  () => props.structure,
  (s) => {
    cols.value = s ? s.columns.map((c) => ({ ...c })) : []
  },
  { immediate: true }
)

function original(i: number): ColumnDef | undefined {
  return props.structure?.columns[i]
}
function commitName(i: number): void {
  const o = original(i)
  const v = cols.value[i]
  if (o && v.name.trim() && v.name !== o.name) emit('alter', { kind: 'renameColumn', from: o.name, to: v.name.trim() })
}
function commitType(i: number): void {
  const o = original(i)
  const v = cols.value[i]
  if (o && v.type.trim() && v.type !== o.type) emit('alter', { kind: 'changeType', name: o.name, type: v.type.trim() })
}
function commitNullable(i: number): void {
  const o = original(i)
  const v = cols.value[i]
  if (o && v.nullable !== o.nullable) emit('alter', { kind: 'setNullable', name: o.name, nullable: v.nullable })
}
function dropColumn(name: string): void {
  if (confirm(`Drop column "${name}"? This deletes its data.`)) emit('alter', { kind: 'dropColumn', name })
}

// Add-column form
const nc = ref({ name: '', type: 'text', nullable: true, default: '' })
function addColumn(): void {
  if (!nc.value.name.trim()) return
  emit('alter', {
    kind: 'addColumn',
    name: nc.value.name.trim(),
    type: nc.value.type.trim() || 'text',
    nullable: nc.value.nullable,
    default: nc.value.default.trim() || undefined
  })
  nc.value = { name: '', type: 'text', nullable: true, default: '' }
}

// Add-FK form
const fk = ref({ column: '', refTable: '', refColumn: '', onDelete: '' })
function addFk(): void {
  if (!fk.value.column || !fk.value.refTable || !fk.value.refColumn) return
  emit('alter', {
    kind: 'addForeignKey',
    column: fk.value.column,
    refTable: fk.value.refTable,
    refColumn: fk.value.refColumn,
    onDelete: fk.value.onDelete || undefined
  })
  fk.value = { column: '', refTable: '', refColumn: '', onDelete: '' }
}
function dropFk(name: string): void {
  if (confirm(`Drop foreign key "${name}"?`)) emit('alter', { kind: 'dropForeignKey', name })
}

// Add-index form
const ix = ref({ columns: '', unique: false, name: '' })
function addIndex(): void {
  const columns = ix.value.columns
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  if (columns.length === 0) return
  emit('alter', {
    kind: 'addIndex',
    columns,
    unique: ix.value.unique,
    name: ix.value.name.trim() || undefined
  })
  ix.value = { columns: '', unique: false, name: '' }
}
function dropIndex(name: string): void {
  if (confirm(`Drop index "${name}"?`)) emit('alter', { kind: 'dropIndex', name })
}
</script>

<template>
  <div class="structure">
    <section>
      <h3>Columns</h3>
      <table class="cols">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th class="c">Null</th>
            <th>Default</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(c, i) in cols" :key="structure?.columns[i]?.name ?? i">
            <td>
              <span v-if="c.isPrimaryKey" class="pk" title="Primary key">PK</span>
              <input class="input sm" v-model="c.name" :disabled="busy" @keydown.enter="commitName(i)" @blur="commitName(i)" />
            </td>
            <td><input class="input sm" v-model="c.type" :disabled="busy" @keydown.enter="commitType(i)" @blur="commitType(i)" /></td>
            <td class="c"><input type="checkbox" v-model="c.nullable" :disabled="busy" @change="commitNullable(i)" /></td>
            <td class="def">{{ c.default ?? '—' }}</td>
            <td class="c"><button class="drop" :disabled="busy" @click="dropColumn(structure!.columns[i].name)">✕</button></td>
          </tr>
        </tbody>
      </table>

      <div class="add-row">
        <input class="input sm" v-model="nc.name" placeholder="new column" />
        <input class="input sm" v-model="nc.type" placeholder="type (e.g. text, int)" />
        <label class="nn"><input type="checkbox" v-model="nc.nullable" /> null</label>
        <input class="input sm" v-model="nc.default" placeholder="default (optional)" />
        <button class="btn btn-primary sm" :disabled="busy || !nc.name.trim()" @click="addColumn">Add column</button>
      </div>
    </section>

    <section>
      <h3>Foreign keys</h3>
      <table class="cols" v-if="structure && structure.foreignKeys.length">
        <thead>
          <tr><th>Name</th><th>Column</th><th>References</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="f in structure.foreignKeys" :key="f.name">
            <td class="mono">{{ f.name }}</td>
            <td class="mono">{{ f.column }}</td>
            <td class="mono">{{ f.refTable }}.{{ f.refColumn }}</td>
            <td class="c"><button class="drop" :disabled="busy" @click="dropFk(f.name)">✕</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="none">No foreign keys.</p>

      <div class="add-row">
        <select class="select sm" v-model="fk.column">
          <option value="" disabled>column…</option>
          <option v-for="c in cols" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
        <span class="arrow">→</span>
        <select class="select sm" v-model="fk.refTable">
          <option value="" disabled>table…</option>
          <option v-for="t in tables" :key="t" :value="t">{{ t }}</option>
        </select>
        <input class="input sm" v-model="fk.refColumn" placeholder="ref column" />
        <select class="select sm" v-model="fk.onDelete">
          <option value="">ON DELETE…</option>
          <option value="cascade">CASCADE</option>
          <option value="set null">SET NULL</option>
          <option value="restrict">RESTRICT</option>
          <option value="no action">NO ACTION</option>
        </select>
        <button class="btn btn-primary sm" :disabled="busy || !fk.column || !fk.refTable || !fk.refColumn" @click="addFk">Add FK</button>
      </div>
    </section>

    <section>
      <h3>Indexes</h3>
      <table class="cols" v-if="structure && structure.indexes.length">
        <thead>
          <tr><th>Name</th><th>Columns</th><th class="c">Unique</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="idx in structure.indexes" :key="idx.name">
            <td class="mono">{{ idx.name }}</td>
            <td class="mono">{{ idx.columns.join(', ') }}</td>
            <td class="c">{{ idx.unique ? '✓' : '' }}</td>
            <td class="c"><button class="drop" :disabled="busy" @click="dropIndex(idx.name)">✕</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="none">No indexes.</p>

      <div class="add-row">
        <input class="input sm" v-model="ix.columns" placeholder="columns (comma-separated)" />
        <label class="nn"><input type="checkbox" v-model="ix.unique" /> unique</label>
        <input class="input sm" v-model="ix.name" placeholder="name (optional)" />
        <button class="btn btn-primary sm" :disabled="busy || !ix.columns.trim()" @click="addIndex">Add index</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.structure {
  height: 100%;
  overflow-y: auto;
  padding: 16px 18px;
  background: var(--bg-panel);
}
section {
  margin-bottom: 26px;
}
h3 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  margin-bottom: 10px;
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
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}
.cols th.c {
  text-align: center;
  width: 50px;
}
.cols td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.cols td.c {
  text-align: center;
}
.input.sm,
.select.sm {
  padding: 4px 7px;
  font-size: 12px;
  width: 100%;
}
.def {
  font-family: var(--mono);
  color: var(--text-faint);
}
.mono {
  font-family: var(--mono);
}
.pk {
  font-size: 9px;
  font-weight: 700;
  background: var(--accent-soft);
  color: var(--accent);
  padding: 1px 4px;
  border-radius: 3px;
  margin-right: 6px;
}
.drop {
  color: var(--danger);
  width: 22px;
  height: 22px;
  border-radius: 4px;
}
.drop:hover {
  background: rgba(229, 97, 106, 0.15);
}
.add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.add-row .input.sm,
.add-row .select.sm {
  width: auto;
  min-width: 120px;
}
.btn.sm {
  padding: 5px 11px;
  white-space: nowrap;
}
.nn {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim);
  font-size: 12px;
}
.arrow {
  color: var(--text-faint);
}
.none {
  color: var(--text-faint);
  font-size: 12px;
  padding: 4px 0;
}
</style>
