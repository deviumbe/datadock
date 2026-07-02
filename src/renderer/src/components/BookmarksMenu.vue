<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Bookmark } from '@shared/types'
import Icon from './Icon.vue'

const props = defineProps<{ connId: string; currentSql: string }>()
const emit = defineEmits<{ load: [sql: string] }>()

const open = ref(false)
const list = ref<Bookmark[]>([])
const naming = ref(false)
const name = ref('')

async function reload(): Promise<void> {
  list.value = await window.api.bookmarks.list(props.connId).catch(() => [])
}
watch(() => props.connId, () => { open.value = false })

async function toggle(): Promise<void> {
  open.value = !open.value
  if (open.value) {
    naming.value = false
    name.value = ''
    await reload()
  }
}
function close(): void {
  open.value = false
  naming.value = false
}

async function save(): Promise<void> {
  const sql = props.currentSql.trim()
  if (!sql) return
  await window.api.bookmarks.save(props.connId, name.value || 'Untitled', sql)
  naming.value = false
  name.value = ''
  await reload()
}
async function remove(b: Bookmark): Promise<void> {
  await window.api.bookmarks.remove(props.connId, b.id)
  await reload()
}
function pick(b: Bookmark): void {
  emit('load', b.sql)
  close()
}
</script>

<template>
  <div class="bm" @mouseleave="open && !naming ? close() : undefined">
    <button class="btn btn-ghost" :class="{ on: open }" title="Bookmarked queries for this connection" @click="toggle">
      <Icon name="bookmark" :size="13" /> Bookmarks
    </button>
    <div v-if="open" class="bm-menu">
      <div class="bm-save">
        <template v-if="naming">
          <input
            v-model="name"
            class="input"
            placeholder="Name this query"
            autofocus
            @keydown.enter="save"
            @keydown.esc="naming = false"
          />
          <button class="btn btn-primary sm" @click="save">Save</button>
        </template>
        <button
          v-else
          class="bm-add"
          :disabled="!currentSql.trim()"
          title="Bookmark the current query"
          @click="naming = true"
        ><Icon name="plus" :size="13" /> Bookmark this query</button>
      </div>

      <div class="bm-list">
        <div v-for="b in list" :key="b.id" class="bm-item" @click="pick(b)">
          <Icon name="bookmark" :size="12" />
          <span class="bm-name" :title="b.sql">{{ b.name }}</span>
          <button class="bm-del" title="Remove" @click.stop="remove(b)"><Icon name="x" :size="11" /></button>
        </div>
        <div v-if="!list.length" class="bm-empty">No bookmarks yet for this connection.</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bm {
  position: relative;
  display: inline-flex;
}
.btn.on {
  color: var(--accent);
}
.bm-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 60;
  width: 280px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
.bm-save {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--border-soft);
}
.bm-save .input {
  flex: 1;
  font-size: 12px;
  padding: 5px 8px;
}
.btn.sm {
  padding: 4px 10px;
}
.bm-add {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--accent);
  border-radius: var(--radius-sm);
}
.bm-add:hover:not(:disabled) {
  background: var(--accent-soft);
}
.bm-add:disabled {
  color: var(--text-faint);
  cursor: default;
}
.bm-list {
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
}
.bm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-faint);
}
.bm-item:hover {
  background: var(--bg-hover);
}
.bm-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bm-del {
  display: inline-flex;
  align-items: center;
  color: var(--text-faint);
  padding: 2px;
  border-radius: 4px;
}
.bm-del:hover {
  color: var(--danger);
  background: rgba(248, 113, 113, 0.15);
}
.bm-empty {
  padding: 12px 10px;
  font-size: 12px;
  color: var(--text-faint);
  text-align: center;
}
</style>
