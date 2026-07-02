<script setup lang="ts">
import { computed } from 'vue'
import type { IoProgress } from '@shared/types'

const props = defineProps<{ progress: IoProgress | null }>()

const percent = computed(() => {
  const p = props.progress
  if (!p) return null
  if (p.phase === 'prepare') return null
  if (p.phase === 'dump' && p.totalRows && p.totalRows > 0)
    return Math.min(100, Math.round(((p.doneRows ?? 0) / p.totalRows) * 100))
  if (p.total > 0) return Math.min(100, Math.round((p.current / p.total) * 100))
  return null
})

function fmtEta(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `~${s}s left`
  const m = Math.round(s / 60)
  if (m < 60) return `~${m}m left`
  const h = Math.floor(m / 60)
  return `~${h}h ${m % 60}m left`
}

const text = computed(() => {
  const p = props.progress
  if (!p) return ''
  if (p.phase === 'prepare') return `Analyzing ${p.label || 'tables'}…`
  if (p.phase === 'import') {
    const mb = p.total > 0 ? ` · ${(p.current / 1048576).toFixed(0)}/${(p.total / 1048576).toFixed(0)} MB` : ''
    return `${p.label || 'Importing'}${mb}`
  }
  // dump phase
  if (!p.label) return 'Finalizing…'
  const eta = p.etaMs != null && p.etaMs > 0 ? ` · ${fmtEta(p.etaMs)}` : ''
  if (p.totalRows && p.totalRows > 0)
    return `Dumping ${p.label} · ${(p.doneRows ?? 0).toLocaleString()}/${p.totalRows.toLocaleString()} rows${eta}`
  if (p.total > 0) {
    const rows = p.rows ? ` · ${p.rows.toLocaleString()} rows` : ''
    return `Dumping ${p.label} · ${p.current}/${p.total} tables${rows}`
  }
  // native dump: the label already carries the full status (e.g. "… — 340 MB")
  return p.label
})
</script>

<template>
  <div v-if="progress" class="pb">
    <div class="track" :class="{ indet: percent === null }">
      <div class="fill" :style="percent !== null ? { width: percent + '%' } : undefined" />
    </div>
    <div class="row">
      <span class="lbl">{{ text }}</span>
      <span v-if="percent !== null" class="pct">{{ percent }}%</span>
    </div>
  </div>
</template>

<style scoped>
.pb {
  width: 100%;
}
.track {
  height: 6px;
  border-radius: 999px;
  background: var(--bg-elevated);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.2s ease;
}
.track.indet .fill {
  width: 35%;
  animation: slide 1.1s ease-in-out infinite;
}
@keyframes slide {
  0% {
    margin-left: -35%;
  }
  100% {
    margin-left: 100%;
  }
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
}
.lbl {
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pct {
  flex: none;
  color: var(--accent);
  font-weight: 600;
}
</style>
