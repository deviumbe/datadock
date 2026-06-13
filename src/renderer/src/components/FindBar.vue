<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import type { QueryResult } from '@shared/types'

interface CellPos {
  rowIndex: number
  colIndex: number
}

const props = defineProps<{
  result: QueryResult | null
  editable?: boolean
  edits?: Record<number, Record<string, unknown>>
}>()

const emit = defineEmits<{
  close: []
  highlight: [pos: CellPos | null]
  highlights: [positions: CellPos[]]
  replaceCell: [rowIndex: number, column: string, value: unknown]
}>()

const searchText = ref('')
const replaceText = ref('')
const caseSensitive = ref(false)
const currentIndex = ref(0)

const searchInput = ref<HTMLInputElement | null>(null)

onMounted(() => {
  nextTick(() => searchInput.value?.focus())
})

function cellValue(r: number, c: number): unknown {
  const name = props.result!.columns[c].name
  const e = props.edits?.[r]
  if (e && name in e) return e[name]
  return props.result!.rows[r][c]
}

function display(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

const matches = computed<CellPos[]>(() => {
  if (!props.result || !searchText.value) return []
  const term = caseSensitive.value ? searchText.value : searchText.value.toLowerCase()
  const positions: CellPos[] = []
  for (let r = 0; r < props.result.rows.length; r++) {
    for (let c = 0; c < props.result.columns.length; c++) {
      const raw = display(cellValue(r, c))
      const text = caseSensitive.value ? raw : raw.toLowerCase()
      if (text.includes(term)) {
        positions.push({ rowIndex: r, colIndex: c })
      }
    }
  }
  return positions
})

const matchCount = computed(() => matches.value.length)
const currentMatch = computed<CellPos | null>(() =>
  matchCount.value > 0 ? matches.value[currentIndex.value] : null
)

watch(matches, (m) => {
  emit('highlights', m)
  if (m.length === 0) {
    currentIndex.value = 0
    emit('highlight', null)
  } else {
    currentIndex.value = Math.min(currentIndex.value, m.length - 1)
    emit('highlight', m[currentIndex.value])
  }
})

watch(currentIndex, () => {
  emit('highlight', currentMatch.value)
})

function goNext(): void {
  if (matchCount.value === 0) return
  currentIndex.value = (currentIndex.value + 1) % matchCount.value
}

function goPrev(): void {
  if (matchCount.value === 0) return
  currentIndex.value = (currentIndex.value - 1 + matchCount.value) % matchCount.value
}

function onSearchKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    if (e.shiftKey) goPrev()
    else goNext()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

function onReplaceKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

function replaceCurrent(): void {
  if (!props.editable || !currentMatch.value || !props.result) return
  const { rowIndex, colIndex } = currentMatch.value
  const col = props.result.columns[colIndex].name
  const raw = display(cellValue(rowIndex, colIndex))
  const term = caseSensitive.value ? searchText.value : searchText.value
  // Build the replaced string
  const flags = caseSensitive.value ? 'g' : 'gi'
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(escaped, flags)
  const newValue = raw.replace(re, replaceText.value)
  emit('replaceCell', rowIndex, col, newValue)
  // After replacement the matches list will recompute; advance to next if possible
  nextTick(() => {
    if (matchCount.value > 0 && currentIndex.value >= matchCount.value) {
      currentIndex.value = 0
    }
  })
}

function replaceAll(): void {
  if (!props.editable || !props.result || matchCount.value === 0) return
  const flags = caseSensitive.value ? 'g' : 'gi'
  const escaped = searchText.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(escaped, flags)
  // Iterate in reverse so indices stay stable
  for (let i = matches.value.length - 1; i >= 0; i--) {
    const { rowIndex, colIndex } = matches.value[i]
    const col = props.result.columns[colIndex].name
    const raw = display(cellValue(rowIndex, colIndex))
    const newValue = raw.replace(re, replaceText.value)
    emit('replaceCell', rowIndex, col, newValue)
  }
  nextTick(() => {
    currentIndex.value = 0
  })
}

function close(): void {
  emit('highlights', [])
  emit('highlight', null)
  emit('close')
}
</script>

<template>
  <div class="find-bar">
    <div class="find-row">
      <input
        ref="searchInput"
        class="find-input"
        v-model="searchText"
        placeholder="Find…"
        @keydown="onSearchKeydown"
      />
      <button
        class="btn-ghost toggle-btn"
        :class="{ active: caseSensitive }"
        title="Case sensitive"
        @click="caseSensitive = !caseSensitive"
      >Aa</button>
      <span class="match-count">
        <template v-if="searchText && matchCount > 0">{{ currentIndex + 1 }} of {{ matchCount }} matches</template>
        <template v-else-if="searchText">No matches</template>
      </span>
      <button class="btn-ghost nav-btn" title="Previous match (Shift+Enter)" :disabled="matchCount === 0" @click="goPrev">▲</button>
      <button class="btn-ghost nav-btn" title="Next match (Enter)" :disabled="matchCount === 0" @click="goNext">▼</button>
      <button class="btn-ghost close-btn" title="Close (Esc)" @click="close">✕</button>
    </div>
    <div v-if="editable" class="replace-row">
      <input
        class="find-input"
        v-model="replaceText"
        placeholder="Replace…"
        @keydown="onReplaceKeydown"
      />
      <button class="btn btn-ghost replace-btn" :disabled="matchCount === 0" @click="replaceCurrent">Replace</button>
      <button class="btn btn-ghost replace-btn" :disabled="matchCount === 0" @click="replaceAll">Replace All</button>
    </div>
  </div>
</template>

<style scoped>
.find-bar {
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
  padding: 5px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.find-row,
.replace-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
}
.find-input {
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 3px 8px;
  font-size: 12px;
  font-family: var(--mono);
  width: 220px;
  outline: none;
}
.find-input:focus {
  border-color: var(--accent);
}
.toggle-btn {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  color: var(--text-faint);
  min-width: 24px;
}
.toggle-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.match-count {
  color: var(--text-faint);
  font-size: 11px;
  font-family: var(--mono);
  min-width: 100px;
  white-space: nowrap;
}
.nav-btn {
  font-size: 10px;
  padding: 2px 5px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
}
.nav-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.nav-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.close-btn {
  font-size: 12px;
  padding: 2px 5px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  margin-left: auto;
}
.close-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.replace-btn {
  font-size: 11px;
  padding: 3px 8px;
}
.replace-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
