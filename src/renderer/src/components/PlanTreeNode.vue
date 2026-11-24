<script setup lang="ts">
import Icon from './Icon.vue'
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
    <div v-press="hasChildren" class="row" :aria-expanded="hasChildren ? open : undefined" :class="{ leaf: !hasChildren }" @click="hasChildren && (open = !open)">
      <span class="twist" v-if="hasChildren"><Icon :name="open ? 'chevronDown' : 'chevronRight'" :size="11" /></span>
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
  font-size: var(--fs-xs);
  flex: none;
  text-align: center;
}
.twist.spacer {
  color: var(--accent-text);
}
.label {
  font-family: var(--mono);
  font-size: var(--fs-base);
  color: var(--text);
  white-space: nowrap;
}
.badge {
  font-size: var(--fs-xs);
  padding: 1px 7px;
  border-radius: 999px;
  white-space: nowrap;
  flex: none;
}
.badge.rows {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.badge.cost {
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-family: var(--mono);
}
.detail {
  font-family: var(--mono);
  font-size: var(--fs-sm);
  color: var(--text-dim);
  padding: 0 8px 4px 20px;
  line-height: 1.4;
}
.children {
  border-left: 1px solid var(--border);
  margin-left: 13px;
}
</style>
