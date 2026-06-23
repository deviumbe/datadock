<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { ErModel } from '@shared/types'
import type { Tab, ExplorerFocus } from '../stores/tabs'
import { useWorkspace } from '../stores/workspace'
import RelatedNode from './RelatedNode.vue'

const props = defineProps<{ tab: Tab }>()
const ws = useWorkspace()

const focus = computed<ExplorerFocus | null>(() => props.tab.relatedFocus ?? null)
const er = ref<ErModel | null>(null)
const loading = ref(false)
const error = ref('')

async function load(): Promise<void> {
  if (!focus.value) return
  loading.value = true
  error.value = ''
  er.value = null
  try {
    er.value = (await ws.loadErModel(props.tab.connectionId)) ?? null
    if (!er.value) error.value = 'Could not load the database relationships.'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
watch(focus, load, { immediate: true })
</script>

<template>
  <div class="related">
    <header class="head">
      <span class="title">Related records</span>
      <span v-if="focus" class="sub">{{ focus.label ?? `${focus.table} #${String(focus.value)}` }}</span>
    </header>
    <div class="body">
      <div v-if="loading" class="state">Loading relationships…</div>
      <div v-else-if="error" class="state err">{{ error }}</div>
      <div v-else-if="!focus" class="state">No record selected.</div>
      <RelatedNode
        v-else-if="er"
        :key="`${focus.table}#${String(focus.value)}`"
        :conn-id="tab.connectionId"
        :er="er"
        :table="focus.table"
        :column="focus.column"
        :value="focus.value"
        :label="focus.label"
        :depth="0"
        :default-open="true"
      />
    </div>
  </div>
</template>

<style scoped>
.related {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
}
.head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--accent);
  font-weight: 700;
}
.sub {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}
.state {
  color: var(--text-dim);
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}
.state.err {
  color: var(--danger);
}
</style>
