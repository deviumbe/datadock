<script setup lang="ts">
import type { PlanNode } from '@shared/types'
import Modal from './Modal.vue'
import PlanTreeNode from './PlanTreeNode.vue'

defineProps<{ root: PlanNode }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Modal title="Query plan" wide @close="emit('close')">
    <p class="lead">
      Estimated execution plan. Expand nodes to drill into the tree — badges show estimated
      row counts and cost.
    </p>
    <div class="tree">
      <PlanTreeNode :node="root" :depth="0" />
    </div>
  </Modal>
</template>

<style scoped>
.lead {
  color: var(--text-dim);
  font-size: 12.5px;
  margin-bottom: 14px;
  line-height: 1.5;
}
.tree {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px;
  overflow-x: auto;
}
</style>
