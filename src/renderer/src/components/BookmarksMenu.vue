<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
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

const trigger = ref<HTMLElement>()
const menu = ref<HTMLElement>()
const nameInput = ref<HTMLInputElement>()
const anchor = ref({ top: 0, right: 0 })
async function startNaming(): Promise<void> {
  naming.value = true
  await nextTick()
  nameInput.value?.focus()
}

async function toggle(): Promise<void> {
  open.value = !open.value
  if (open.value) {
    const r = trigger.value!.getBoundingClientRect()
    anchor.value = { top: r.bottom + 6, right: window.innerWidth - r.right }
    naming.value = false
    name.value = ''
    await reload()
    await nextTick()
    menu.value?.querySelector<HTMLElement>('button:not(:disabled), [data-row]')?.focus()
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
function onEscape(): void {
  if (naming.value) naming.value = false
  else close()
  trigger.value?.focus()
}
function pick(b: Bookmark): void {
  emit('load', b.sql)
  close()
}
</script>

<template>
  <div class="bm">
    <button
      ref="trigger"
      class="btn btn-ghost"
      :class="{ on: open }"
      title="Bookmarked queries for this connection"
      :aria-expanded="open"
      @click="toggle"
    >
      <Icon name="bookmark" :size="13" /> <span class="lbl">Bookmarks</span>
    </button>
    <Teleport to="body">
    <div v-if="open" class="bm-scrim" @mousedown="close" />
    <div v-if="open" ref="menu" class="bm-menu" role="dialog" aria-label="Bookmarked queries" @keydown.esc.stop="onEscape" :style="{ top: `${anchor.top}px`, right: `${anchor.right}px` }">
      <div class="bm-save">
        <template v-if="naming">
          <input
            ref="nameInput"
            v-model="name"
            class="input"
            aria-label="Bookmark name"
            placeholder="Name this query"
            @keydown.enter="save"
          />
          <button class="btn btn-primary sm" @click="save">Save</button>
        </template>
        <button
          v-else
          class="bm-add"
          :disabled="!currentSql.trim()"
          title="Bookmark the current query"
          @click="startNaming"
        ><Icon name="plus" :size="13" /> Bookmark this query</button>
      </div>

      <div class="bm-list" role="list" data-rows>
        <div v-for="b in list" :key="b.id" v-row role="listitem" class="bm-item" @click="pick(b)">
          <Icon name="bookmark" :size="12" />
          <span class="bm-name" :title="b.sql">{{ b.name }}</span>
          <span data-row-actions><button class="bm-del" :title="`Remove ${b.name}`" @click.stop="remove(b)"><Icon name="x" :size="11" /></button></span>
        </div>
        <div v-if="!list.length" class="bm-empty">No bookmarks yet for this connection.</div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
.bm {
  position: relative;
  display: inline-flex;
}
.btn.on {
  color: var(--accent-text);
}
.bm-scrim {
  position: fixed;
  inset: 0;
  z-index: 59;
}
.bm-menu {
  /* Teleported: the toolbar it belongs to scrolls and would clip it. */
  position: fixed;
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
  font-size: var(--fs-sm);
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
  font-size: var(--fs-sm);
  color: var(--accent-text);
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
  font-size: var(--fs-base);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bm-del {
  display: inline-flex;
  align-items: center;
  color: var(--text-faint);
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
}
.bm-del:hover {
  color: var(--danger-text);
  background: var(--danger-soft);
}
.bm-empty {
  padding: 12px 10px;
  font-size: var(--fs-sm);
  color: var(--text-faint);
  text-align: center;
}
</style>
