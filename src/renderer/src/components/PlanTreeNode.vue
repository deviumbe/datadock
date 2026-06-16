<script setup lang="ts">
import { ref } from 'vue'
import type { PlanNode } from '@shared/types'

const props = defineProps<{ node: PlanNode; depth?: number }>()
const open = ref(true)

const depth = props.depth ?? 0
const hasChildren = props.node.children.length > 0

function fmtRows(n?: number): string {
  if (n == null) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}
</script>

<template>
  <div class="plan-node" :style="{ marginLeft: depth ? '18px' : '0' }">
    <div class="row" :class="{ leaf: !hasChildren }" @click="hasChildren && (open = !open)">
      <span class="twist" v-if="hasChildren">{{ open ? '▾' : '▸' }}</span>
      <span class="twist spacer" v-else>•</span>
      <span class="label">{{ node.label }}</span>
      <span v-if="node.rows != null" class="badge rows" title="Estimated rows">~{{ fmtRows(node.rows) }} rows</span>
      <span v-if="node.cost != null" class="badge cost" title="Estimated total cost">{{ node.cost.toFixed(2) }}</span>
    </div>
    <div v-if="node.detail" class="detail" :style="{ marginLeft: '18px' }">{{ node.detail }}</div>
    <div v-if="hasChildren && open" class="children">
      <PlanTreeNode v-for="(child, i) in node.children" :key="i" :node="child" :depth="depth + 1" />
    </div>
  </div>
</template>

<style scoped>
.plan-node {
  position: relative;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  cursor: default;
}
.row:not(.leaf) {
  cursor: pointer;
}
.row:hover {
  background: var(--bg-hover);
}
.twist {
  width: 12px;
  color: var(--text-faint);
  font-size: 10px;
  flex: none;
  text-align: center;
}
.twist.spacer {
  color: var(--accent);
}
.label {
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--text);
  white-space: nowrap;
}
.badge {
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  white-space: nowrap;
  flex: none;
}
.badge.rows {
  background: var(--accent-soft);
  color: var(--accent);
}
.badge.cost {
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-family: var(--mono);
}
.detail {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-dim);
  padding: 0 8px 4px 20px;
  line-height: 1.4;
}
.children {
  border-left: 1px solid var(--border);
  margin-left: 13px;
}
</style>
