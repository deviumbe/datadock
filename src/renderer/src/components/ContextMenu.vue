<script setup lang="ts">
export interface MenuItem {
  label?: string
  danger?: boolean
  sep?: boolean
  shortcut?: string
  disabled?: boolean
  /** Marks the current choice in a list of alternatives. */
  checked?: boolean
  action?: () => void
  /** Nested items — renders a flyout submenu. */
  children?: MenuItem[]
}
import { nextTick, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { useDialog } from '../lib/dialog'
const props = defineProps<{ x: number; y: number; items: MenuItem[] }>()
const emit = defineEmits<{ close: [] }>()

const openIdx = ref<number | null>(null)
const menu = ref<HTMLElement>()
const pos = ref({ x: props.x, y: props.y })

function onEscape(): void {
  const i = openIdx.value
  if (i === null) {
    emit('close')
    return
  }
  openIdx.value = null
  parentButton(i)?.focus()
}
useDialog(menu, { onEscape })

const EDGE = 8
onMounted(() => {
  // offset* ignores the entrance scale, which a client rect would include.
  const { offsetWidth, offsetHeight } = menu.value!
  pos.value = {
    x: Math.max(EDGE, Math.min(props.x, window.innerWidth - offsetWidth - EDGE)),
    y: Math.max(EDGE, Math.min(props.y, window.innerHeight - offsetHeight - EDGE))
  }
})

function pick(item: MenuItem): void {
  if (item.sep || item.children || item.disabled) return
  // Close first so focus is back on the trigger before the action opens a dialog.
  emit('close')
  void nextTick(() => item.action?.())
}

function parentButton(i: number): HTMLElement | null {
  return menu.value?.querySelector<HTMLElement>(`[data-parent="${i}"]`) ?? null
}

async function openSub(i: number): Promise<void> {
  openIdx.value = i
  await nextTick()
  parentButton(i)?.parentElement?.querySelector<HTMLElement>('.cm-sub .cm-item')?.focus()
}

function onMenuKeydown(e: KeyboardEvent): void {
  const at = document.activeElement as HTMLElement
  const scope = at.closest<HTMLElement>('[role="menu"]')
  if (!scope) return
  const items = [...scope.querySelectorAll<HTMLElement>('.cm-item')].filter(
    (el) => el.closest('[role="menu"]') === scope && !el.hasAttribute('disabled')
  )
  const i = items.indexOf(at)
  const parent = at.dataset.parent
  if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus()
  else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus()
  else if (e.key === 'Home') items[0]?.focus()
  else if (e.key === 'End') items[items.length - 1]?.focus()
  else if (e.key === 'ArrowRight' && parent !== undefined) void openSub(Number(parent))
  else if (e.key === 'ArrowLeft' && scope !== menu.value) onEscape()
  else if (e.key === 'Tab') emit('close')
  else return
  e.preventDefault()
  e.stopPropagation()
}
</script>

<template>
  <Teleport to="body">
    <div class="cm-overlay" @mousedown="emit('close')" @contextmenu.prevent="emit('close')">
      <div
        ref="menu"
        class="cm pop-in"
        role="menu"
        tabindex="-1"
        :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
        @mousedown.stop
        @keydown="onMenuKeydown"
      >
        <template v-for="(it, i) in items" :key="i">
          <div v-if="it.sep" class="cm-sep" role="separator" />
          <div
            v-else-if="it.children"
            class="cm-parent"
            @mouseenter="openIdx = i"
            @mouseleave="openIdx = null"
          >
            <button
              class="cm-item"
              role="menuitem"
              aria-haspopup="menu"
              :aria-expanded="openIdx === i"
              :data-parent="i"
              @click.stop="openSub(i)"
            >
              <span class="cm-label">{{ it.label }}</span>
              <Icon name="chevronRight" :size="12" class="cm-arrow" />
            </button>
            <div v-if="openIdx === i" class="cm cm-sub" role="menu" :aria-label="it.label" @mousedown.stop>
              <template v-for="(sub, j) in it.children" :key="j">
                <div v-if="sub.sep" class="cm-sep" role="separator" />
                <button
                  v-else
                  class="cm-item"
                  :class="{ danger: sub.danger }"
                  role="menuitem"
                  :disabled="sub.disabled"
                  @click="pick(sub)"
                >
                  <span class="cm-label">{{ sub.label }}</span>
                  <span v-if="sub.shortcut" class="cm-shortcut">{{ sub.shortcut }}</span>
                </button>
              </template>
            </div>
          </div>
          <button
            v-else
            class="cm-item"
            :class="{ danger: it.danger }"
            :role="it.checked === undefined ? 'menuitem' : 'menuitemradio'"
            :aria-checked="it.checked"
            :disabled="it.disabled"
            @click="pick(it)"
          >
            <span v-if="it.checked !== undefined" class="cm-check"><Icon v-if="it.checked" name="check" :size="12" /></span>
            <span class="cm-label">{{ it.label }}</span>
            <span v-if="it.shortcut" class="cm-shortcut">{{ it.shortcut }}</span>
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cm-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
}
.cm {
  position: fixed;
  min-width: 170px;
  max-height: calc(100vh - 16px);
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  padding: 4px;
}
.pop-in {
  transform-origin: top left;
  animation: cm-pop var(--dur-2) var(--ease-out) both;
}
@keyframes cm-pop {
  from {
    opacity: 0;
    transform: scale(0.94) translateY(-3px);
  }
}
.cm-item {
  display: flex;
  align-items: center;
  gap: 18px;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: var(--fs-base);
  color: var(--text);
  transition: background 0.08s, color 0.08s;
}
.cm-label {
  flex: 1;
}
.cm-shortcut {
  font-size: var(--fs-xs);
  color: var(--text-faint);
}
.cm-arrow {
  color: var(--text-faint);
}
.cm-check {
  width: 12px;
  display: inline-flex;
}
.cm-item:disabled {
  color: var(--text-faint);
  cursor: default;
}
.cm-item:focus-visible {
  outline-offset: -2px;
}
.cm-item:not(:disabled):hover {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.cm-item.danger:not(:disabled):hover {
  background: var(--danger-soft);
  color: var(--danger-text);
}
.cm-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
/* Submenu flyout */
.cm-parent {
  position: relative;
}
.cm-sub {
  position: absolute;
  left: 100%;
  top: -5px;
  margin-left: 2px;
  max-height: 60vh;
  overflow-y: auto;
  z-index: 1;
}
</style>
