<script setup lang="ts">
import { useUi } from '../stores/ui'
import Icon from './Icon.vue'
import { ref, watch, computed } from 'vue'
import type { AlterOp, ColumnDef, TableStructure } from '@shared/types'

const ui = useUi()

const props = defineProps<{
  structure: TableStructure | null
  tables: string[]
  busy: boolean
  readOnly?: boolean
}>()
const emit = defineEmits<{ alter: [op: AlterOp] }>()

const locked = computed(() => props.busy || !!props.readOnly)
function fire(op: AlterOp): void {
  if (props.readOnly) return
  emit('alter', op)
}

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
  if (o && v.name.trim() && v.name !== o.name) fire({ kind: 'renameColumn', from: o.name, to: v.name.trim() })
}
function commitType(i: number): void {
  const o = original(i)
  const v = cols.value[i]
  if (o && v.type.trim() && v.type !== o.type) fire({ kind: 'changeType', name: o.name, type: v.type.trim() })
}
function commitNullable(i: number): void {
  const o = original(i)
  const v = cols.value[i]
  if (o && v.nullable !== o.nullable) fire({ kind: 'setNullable', name: o.name, nullable: v.nullable })
}
async function dropColumn(name: string): Promise<void> {
  const ok = await ui.confirmDialog({
    title: 'Drop column',
    message: `Drop column "${name}"? This deletes its data.`,
    confirmLabel: 'Drop column',
    danger: true
  })
  if (ok) fire({ kind: 'dropColumn', name })
}

// Add-column form
const nc = ref({ name: '', type: 'text', nullable: true, default: '' })
function addColumn(): void {
  if (!nc.value.name.trim()) return
  fire({
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
  fire({
    kind: 'addForeignKey',
    column: fk.value.column,
    refTable: fk.value.refTable,
    refColumn: fk.value.refColumn,
    onDelete: fk.value.onDelete || undefined
  })
  fk.value = { column: '', refTable: '', refColumn: '', onDelete: '' }
}
async function dropFk(name: string): Promise<void> {
  const ok = await ui.confirmDialog({
    title: 'Drop foreign key',
    message: `Drop foreign key "${name}"?`,
    confirmLabel: 'Drop foreign key',
    danger: true
  })
  if (ok) fire({ kind: 'dropForeignKey', name })
}

// Add-index form
const ix = ref({ columns: '', unique: false, name: '' })
function addIndex(): void {
  const columns = ix.value.columns
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  if (columns.length === 0) return
  fire({
    kind: 'addIndex',
    columns,
    unique: ix.value.unique,
    name: ix.value.name.trim() || undefined
  })
  ix.value = { columns: '', unique: false, name: '' }
}
async function dropIndex(name: string): Promise<void> {
  const ok = await ui.confirmDialog({
    title: 'Drop index',
    message: `Drop index "${name}"?`,
    confirmLabel: 'Drop index',
    danger: true
  })
  if (ok) fire({ kind: 'dropIndex', name })
}
</script>

<template>
  <div class="structure">
    <div v-if="readOnly" class="ro-note"><Icon name="lock" :size="13" /> Read-only connection: structure changes are disabled.</div>
    <section>
      <h2>Columns</h2>
      <table class="cols">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th class="c">Null</th>
            <th>Default</th>
            <th><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(c, i) in cols" :key="structure?.columns[i]?.name ?? i">
            <td>
              <div class="namecell">
              <span v-if="c.isPrimaryKey" class="pk" data-tooltip="Primary key">PK</span>
              <input class="input sm" v-model="c.name" aria-label="Column name" :disabled="locked" @keydown.enter="commitName(i)" @blur="commitName(i)" />
              </div>
            </td>
            <td><input class="input sm" v-model="c.type" aria-label="Column type" :disabled="locked" @keydown.enter="commitType(i)" @blur="commitType(i)" /></td>
            <td class="c"><input type="checkbox" v-model="c.nullable" aria-label="Nullable" :disabled="locked" @change="commitNullable(i)" /></td>
            <td class="def">{{ c.default ?? '—' }}</td>
            <td class="c"><button class="drop" title="Drop column" :disabled="locked" @click="dropColumn(structure!.columns[i].name)"><Icon name="x" :size="12" /></button></td>
          </tr>
        </tbody>
      </table>

      <div class="add-row">
        <input aria-label="New column name" class="input sm" v-model="nc.name" placeholder="new column" />
        <input aria-label="New column type" class="input sm" v-model="nc.type" placeholder="type (e.g. text, int)" />
        <label class="nn"><input type="checkbox" v-model="nc.nullable" /> null</label>
        <input aria-label="New column default" class="input sm" v-model="nc.default" placeholder="default (optional)" />
        <button class="btn btn-primary sm" :disabled="locked || !nc.name.trim()" @click="addColumn">Add column</button>
      </div>
    </section>

    <section>
      <h2>Foreign keys</h2>
      <table class="cols" v-if="structure && structure.foreignKeys.length">
        <thead>
          <tr><th>Name</th><th>Column</th><th>References</th><th><span class="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          <tr v-for="f in structure.foreignKeys" :key="f.name">
            <td class="mono">{{ f.name }}</td>
            <td class="mono">{{ f.column }}</td>
            <td class="mono">{{ f.refTable }}.{{ f.refColumn }}</td>
            <td class="c"><button class="drop" title="Drop foreign key" :disabled="locked" @click="dropFk(f.name)"><Icon name="x" :size="12" /></button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="none">No foreign keys.</p>

      <div class="add-row">
        <select class="select sm" v-model="fk.column" aria-label="Column">
          <option value="" disabled>column…</option>
          <option v-for="c in cols" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
        <span class="arrow"><Icon name="arrowRight" :size="14" /></span>
        <select class="select sm" v-model="fk.refTable" aria-label="Referenced table">
          <option value="" disabled>table…</option>
          <option v-for="t in tables" :key="t" :value="t">{{ t }}</option>
        </select>
        <input aria-label="Referenced column" class="input sm" v-model="fk.refColumn" placeholder="ref column" />
        <select class="select sm" v-model="fk.onDelete" aria-label="On delete">
          <option value="">ON DELETE…</option>
          <option value="cascade">CASCADE</option>
          <option value="set null">SET NULL</option>
          <option value="restrict">RESTRICT</option>
          <option value="no action">NO ACTION</option>
        </select>
        <button class="btn btn-primary sm" :disabled="locked || !fk.column || !fk.refTable || !fk.refColumn" @click="addFk">Add FK</button>
      </div>
    </section>

    <section>
      <h2>Indexes</h2>
      <table class="cols" v-if="structure && structure.indexes.length">
        <thead>
          <tr><th>Name</th><th>Columns</th><th class="c">Unique</th><th><span class="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          <tr v-for="idx in structure.indexes" :key="idx.name">
            <td class="mono">{{ idx.name }}</td>
            <td class="mono">{{ idx.columns.join(', ') }}</td>
            <td class="c"><Icon v-if="idx.unique" name="check" :size="13" /><span v-if="idx.unique" class="sr-only">unique</span></td>
            <td class="c"><button class="drop" title="Drop index" :disabled="locked" @click="dropIndex(idx.name)"><Icon name="x" :size="12" /></button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="none">No indexes.</p>

      <div class="add-row">
        <input aria-label="Index columns, comma-separated" class="input sm" v-model="ix.columns" placeholder="columns (comma-separated)" />
        <label class="nn"><input type="checkbox" v-model="ix.unique" /> unique</label>
        <input aria-label="Index name" class="input sm" v-model="ix.name" placeholder="name (optional)" />
        <button class="btn btn-primary sm" :disabled="locked || !ix.columns.trim()" @click="addIndex">Add index</button>
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
.ro-note {
  margin-bottom: 14px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn-text);
  font-size: var(--fs-sm);
}
section {
  margin-bottom: 26px;
}
h2 {
  font-size: var(--fs-sm);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  margin-bottom: 10px;
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
  font-size: var(--fs-sm);
  width: 100%;
}
.def {
  font-family: var(--mono);
  color: var(--text-faint);
}
.mono {
  font-family: var(--mono);
}
.namecell {
  display: flex;
  align-items: center;
}
.pk {
  flex: none;
  font-size: var(--fs-xs);
  font-weight: 700;
  background: var(--accent-soft);
  color: var(--accent-text);
  padding: 1px 4px;
  border-radius: 3px;
  margin-right: 6px;
}
.drop {
  color: var(--danger-text);
  width: 24px;
  height: 24px;
  border-radius: 4px;
}
.drop:hover {
  background: var(--danger-soft);
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
  font-size: var(--fs-sm);
}
.arrow {
  color: var(--text-faint);
}
.none {
  color: var(--text-faint);
  font-size: var(--fs-sm);
  padding: 4px 0;
}
</style>
