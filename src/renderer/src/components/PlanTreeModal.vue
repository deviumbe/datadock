<script setup lang="ts">
import { computed } from 'vue'
import type { PlanBaseline, PlanNode } from '@shared/types'
import Modal from './Modal.vue'
import PlanTreeNode from './PlanTreeNode.vue'

const props = defineProps<{
  root: PlanNode
  currentCost?: number | null
  baseline?: PlanBaseline | null
  justSaved?: boolean
}>()
const emit = defineEmits<{ close: []; updateBaseline: [] }>()

const REGRESS = 1.2 // ≥20% costlier than baseline → flag a regression
const IMPROVE = 0.8 // ≤20% cheaper → note an improvement

const fmtCost = (n: number): string =>
  n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toFixed(1)

const ratio = computed(() => {
  if (props.currentCost == null || !props.baseline?.cost) return null
  return props.currentCost / props.baseline.cost
})

type Verdict = 'captured' | 'regressed' | 'improved' | 'steady'
const verdict = computed<Verdict | null>(() => {
  if (props.currentCost == null || !props.baseline) return null
  if (props.justSaved) return 'captured'
  const r = ratio.value
  if (r == null) return null
  if (r >= REGRESS) return 'regressed'
  if (r <= IMPROVE) return 'improved'
  return 'steady'
})

const savedWhen = computed(() =>
  props.baseline
    ? new Date(props.baseline.savedAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : ''
)
</script>

<template>
  <Modal title="Query plan" wide @close="emit('close')">
    <p class="lead">
      Estimated execution plan. Expand nodes to drill into the tree — badges show estimated
      row counts and cost.
    </p>

    <!-- Regression alert: this plan's cost vs the saved baseline -->
    <div v-if="verdict" class="alert" :class="verdict">
      <span class="a-ic">{{
        verdict === 'regressed' ? '⚠' : verdict === 'improved' ? '↓' : verdict === 'captured' ? '📍' : '✓'
      }}</span>
      <span class="a-msg">
        <template v-if="verdict === 'captured'">
          Baseline captured at cost <strong>{{ fmtCost(currentCost!) }}</strong>. Future plans for
          this query will be compared against it.
        </template>
        <template v-else-if="verdict === 'regressed'">
          Plan cost <strong>regressed</strong>: {{ fmtCost(baseline!.cost) }} →
          <strong>{{ fmtCost(currentCost!) }}</strong> ({{ ratio!.toFixed(1) }}× costlier) since
          baseline of {{ savedWhen }}.
        </template>
        <template v-else-if="verdict === 'improved'">
          Plan cost <strong>improved</strong>: {{ fmtCost(baseline!.cost) }} →
          <strong>{{ fmtCost(currentCost!) }}</strong> since baseline of {{ savedWhen }}.
        </template>
        <template v-else>
          Plan cost steady (~{{ fmtCost(currentCost!) }}) vs baseline {{ fmtCost(baseline!.cost) }}
          from {{ savedWhen }}.
        </template>
      </span>
      <button
        v-if="verdict !== 'captured'"
        class="a-btn"
        title="Use the current cost as the new baseline"
        @click="emit('updateBaseline')"
      >
        Update baseline
      </button>
    </div>

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
.alert {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  margin-bottom: 12px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  line-height: 1.45;
  border: 1px solid var(--border);
}
.alert .a-ic {
  flex: none;
  font-size: 14px;
}
.alert .a-msg {
  flex: 1;
  color: var(--text-dim);
}
.alert .a-msg strong {
  color: var(--text);
}
.alert.regressed {
  background: rgba(248, 113, 113, 0.1);
  border-color: rgba(248, 113, 113, 0.4);
}
.alert.regressed .a-ic {
  color: var(--danger);
}
.alert.improved {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.alert.improved .a-ic,
.alert.steady .a-ic {
  color: var(--ok);
}
.alert.captured {
  background: var(--bg-elevated);
}
.a-btn {
  flex: none;
  font-size: 11.5px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
}
.a-btn:hover {
  color: var(--text);
  border-color: var(--accent);
}
.tree {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px;
  overflow-x: auto;
}
</style>
