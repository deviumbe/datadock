<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import Modal from './Modal.vue'
import type { ErRelation } from '@shared/types'

const props = defineProps<{ connId: string; table: string }>()
const emit = defineEmits<{ open: [name: string]; close: [] }>()

const loading = ref(true)
const error = ref('')
const relations = ref<ErRelation[]>([])

onMounted(async () => {
  try {
    const model = await window.api.db.erModel(props.connId)
    relations.value = model.relations
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

// Outgoing: this table's foreign keys point at another table.
const references = computed(() => relations.value.filter((r) => r.fromTable === props.table))
// Incoming: other tables' foreign keys point at this table.
const referencedBy = computed(() => relations.value.filter((r) => r.toTable === props.table))
</script>

<template>
  <Modal :title="`Dependencies · ${table}`" wide @close="emit('close')">
    <div v-if="loading" class="state">Loading foreign-key graph…</div>
    <div v-else-if="error" class="state err">{{ error }}</div>
    <template v-else>
      <section>
        <h3>References <span class="count">{{ references.length }}</span></h3>
        <p class="hint">Tables this one points to (its outgoing foreign keys).</p>
        <ul v-if="references.length">
          <li v-for="(r, i) in references" :key="'out-' + i">
            <code class="col">{{ r.fromColumn }}</code>
            <span class="arrow">→</span>
            <button class="link" @click="emit('open', r.toTable)">{{ r.toTable }}</button>
            <code class="col dim">{{ r.toColumn }}</code>
          </li>
        </ul>
        <p v-else class="empty">No outgoing foreign keys.</p>
      </section>

      <section>
        <h3>Referenced by <span class="count">{{ referencedBy.length }}</span></h3>
        <p class="hint">Tables that point at this one (incoming foreign keys) — these block a drop.</p>
        <ul v-if="referencedBy.length">
          <li v-for="(r, i) in referencedBy" :key="'in-' + i">
            <button class="link" @click="emit('open', r.fromTable)">{{ r.fromTable }}</button>
            <code class="col">{{ r.fromColumn }}</code>
            <span class="arrow">→</span>
            <code class="col dim">{{ r.toColumn }}</code>
          </li>
        </ul>
        <p v-else class="empty">Nothing references this table.</p>
      </section>
    </template>
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
section {
  margin-bottom: 20px;
}
section:last-of-type {
  margin-bottom: 0;
}
h3 {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.count {
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  border-radius: 999px;
  padding: 1px 8px;
}
.hint {
  color: var(--text-faint);
  font-size: 11.5px;
  margin: 4px 0 10px;
}
ul {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}
.col {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text);
}
.col.dim {
  color: var(--text-dim);
}
.arrow {
  color: var(--text-faint);
}
.link {
  color: var(--accent);
  font-weight: 600;
  font-size: 12.5px;
}
.link:hover {
  text-decoration: underline;
}
.empty {
  color: var(--text-faint);
  font-size: 12px;
  font-style: italic;
}
</style>
