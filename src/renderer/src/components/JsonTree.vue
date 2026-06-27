<script setup lang="ts">
// A small collapsible JSON tree. Self-referential: renders nested objects/arrays
// recursively. Auto-expands the first couple of levels for quick scanning.
import { ref, computed } from 'vue'

const props = defineProps<{ data: unknown; name?: string; depth?: number }>()

const depth = computed(() => props.depth ?? 0)
const open = ref(depth.value < 2)

const kind = computed(() => {
  const d = props.data
  if (d === null) return 'null'
  if (Array.isArray(d)) return 'array'
  return typeof d
})
const isContainer = computed(() => kind.value === 'object' || kind.value === 'array')
const entries = computed<[string, unknown][]>(() => {
  if (kind.value === 'array') return (props.data as unknown[]).map((v, i) => [String(i), v])
  if (kind.value === 'object') return Object.entries(props.data as Record<string, unknown>)
  return []
})
const summary = computed(() => {
  if (kind.value === 'array') return `Array(${(props.data as unknown[]).length})`
  if (kind.value === 'object') return `{ ${Object.keys(props.data as object).length} }`
  return ''
})
function primitive(v: unknown): string {
  return typeof v === 'string' ? `"${v}"` : String(v)
}
</script>

<template>
  <div class="node">
    <!-- object / array -->
    <template v-if="isContainer">
      <div class="row toggle" @click="open = !open">
        <span class="caret">{{ open ? '▾' : '▸' }}</span>
        <span v-if="name !== undefined" class="key">{{ name }}</span>
        <span class="muted">{{ summary }}</span>
      </div>
      <div v-if="open" class="children">
        <JsonTree v-for="[k, v] in entries" :key="k" :data="v" :name="k" :depth="depth + 1" />
      </div>
    </template>

    <!-- primitive leaf -->
    <div v-else class="row leaf">
      <span v-if="name !== undefined" class="key">{{ name }}</span>
      <span class="val" :class="kind">{{ primitive(data) }}</span>
    </div>
  </div>
</template>

<style scoped>
.node {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.7;
}
.children {
  padding-left: 15px;
  border-left: 1px solid var(--border);
  margin-left: 4px;
}
.row {
  display: flex;
  gap: 6px;
  align-items: baseline;
  white-space: pre-wrap;
  word-break: break-word;
}
.toggle {
  cursor: pointer;
}
.toggle:hover .key {
  color: var(--text);
}
.caret {
  color: var(--text-faint);
  width: 10px;
  flex: none;
}
.key {
  color: var(--accent);
}
.key::after {
  content: ':';
  color: var(--text-faint);
}
.muted {
  color: var(--text-faint);
}
.val.string {
  color: #a5d6a7;
}
.val.number {
  color: #f0b429;
}
.val.boolean {
  color: #f0b429;
}
.val.null {
  color: var(--text-faint);
  font-style: italic;
}
.leaf .key {
  margin-left: 16px;
}
</style>
