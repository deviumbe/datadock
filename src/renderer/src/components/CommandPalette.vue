<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useWorkspace } from '../stores/workspace'
import { useTabs } from '../stores/tabs'
import { useUi } from '../stores/ui'

const emit = defineEmits<{ close: []; action: [action: string] }>()

const ws = useWorkspace()
const tabsStore = useTabs()
const ui = useUi()

const query = ref('')
const selectedIndex = ref(0)
const inputEl = ref<HTMLInputElement>()
const listEl = ref<HTMLElement>()

interface PaletteItem {
  id: string
  label: string
  icon: string
  category: 'Connections' | 'Tables' | 'Actions'
  action: () => void
}

const allItems = computed<PaletteItem[]>(() => {
  const items: PaletteItem[] = []

  // ---- Connections ----------------------------------------------------------
  for (const project of ws.projects) {
    for (const env of project.environments) {
      for (const conn of env.connections) {
        items.push({
          id: `conn-${conn.id}`,
          label: conn.name,
          icon: '🔌',
          category: 'Connections',
          action: () => {
            void ws.connectAndOpen(conn.id)
            emit('close')
          }
        })
      }
    }
  }

  // ---- Tables (only when connected) ----------------------------------------
  const connId = ws.activeConnectionId
  if (connId && ws.connStates[connId] === 'connected') {
    for (const table of ws.tables) {
      items.push({
        id: `table-${table.schema ?? ''}.${table.name}`,
        label: table.name,
        icon: table.type === 'view' ? '◫' : '▦',
        category: 'Tables',
        action: () => {
          tabsStore.openTable(connId, table)
          emit('close')
        }
      })
    }
  }

  // ---- Actions --------------------------------------------------------------
  const actions: { label: string; icon: string; handler: () => void }[] = [
    {
      label: 'New Query',
      icon: '＋',
      handler: () => {
        if (connId) tabsStore.openQuery(connId)
      }
    },
    { label: 'Toggle Theme', icon: '☀', handler: () => ui.toggleTheme() },
    { label: 'Toggle Sidebar', icon: '☰', handler: () => ui.toggleSidebar() },
    {
      label: 'Databases',
      icon: '🗄',
      handler: () => {
        if (connId) tabsStore.openServer(connId, 'databases')
      }
    },
    {
      label: 'Users',
      icon: '👤',
      handler: () => {
        if (connId) tabsStore.openServer(connId, 'users')
      }
    },
    {
      label: 'Table Sizes',
      icon: '📊',
      handler: () => {
        if (connId) ui.tableSizesOpen = true
      }
    },
    {
      label: 'Search Schema',
      icon: '🔎',
      handler: () => {
        if (connId) ui.columnSearchOpen = true
      }
    },
    {
      label: 'Processes',
      icon: '⚙',
      handler: () => {
        if (connId) tabsStore.openServer(connId, 'processes')
      }
    },
    {
      label: 'Query History',
      icon: '🕑',
      handler: () => {
        if (connId) tabsStore.openHistory(connId)
      }
    },
    {
      label: 'Saved Queries',
      icon: '★',
      handler: () => {
        if (connId) tabsStore.openSnippets(connId)
      }
    },
    {
      label: 'Disconnect',
      icon: '⏏',
      handler: () => {
        if (connId) void ws.disconnect(connId)
      }
    },
    {
      label: 'Import',
      icon: '📥',
      handler: () => {
        if (connId) {
          if (ws.findConnection(connId)?.readOnly) {
            ws.error = 'Read-only connection: import is disabled.'
          } else {
            ui.importOpen = true
          }
        }
      }
    },
    {
      label: 'Export Database',
      icon: '📤',
      handler: () => {
        if (connId) ui.exportDbOpen = true
      }
    },
    {
      label: 'ER Diagram',
      icon: '🔗',
      handler: () => {
        if (connId) tabsStore.openDiagram(connId)
      }
    }
  ]

  for (const a of actions) {
    items.push({
      id: `action-${a.label}`,
      label: a.label,
      icon: a.icon,
      category: 'Actions',
      action: () => {
        a.handler()
        emit('close')
      }
    })
  }

  return items
})

const filtered = computed<PaletteItem[]>(() => {
  const q = query.value.toLowerCase().trim()
  if (!q) return allItems.value
  return allItems.value.filter(
    (item) =>
      item.label.toLowerCase().includes(q) || item.category.toLowerCase().includes(q)
  )
})

// Group items by category for rendering
const grouped = computed(() => {
  const groups: { category: string; items: { item: PaletteItem; globalIndex: number }[] }[] = []
  const categoryMap = new Map<string, { item: PaletteItem; globalIndex: number }[]>()
  const order: string[] = []

  filtered.value.forEach((item, idx) => {
    if (!categoryMap.has(item.category)) {
      categoryMap.set(item.category, [])
      order.push(item.category)
    }
    categoryMap.get(item.category)!.push({ item, globalIndex: idx })
  })

  for (const cat of order) {
    groups.push({ category: cat, items: categoryMap.get(cat)! })
  }
  return groups
})

// Reset selection on query change
watch(query, () => {
  selectedIndex.value = 0
})

function scrollToSelected(): void {
  nextTick(() => {
    const el = listEl.value?.querySelector('.item.selected')
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function onKeydown(e: KeyboardEvent): void {
  const count = filtered.value.length
  if (!count) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = (selectedIndex.value + 1) % count
    scrollToSelected()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = (selectedIndex.value - 1 + count) % count
    scrollToSelected()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const item = filtered.value[selectedIndex.value]
    if (item) item.action()
  }
}

onMounted(() => {
  inputEl.value?.focus()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="palette">
      <div class="backdrop" @mousedown.self="emit('close')">
        <div class="palette" @keydown="onKeydown">
          <div class="search-bar">
            <span class="search-icon">⌘</span>
            <input
              ref="inputEl"
              v-model="query"
              class="search-input"
              placeholder="Search connections, tables, actions…"
              @keydown.esc="emit('close')"
            />
          </div>
          <div ref="listEl" class="list">
            <template v-if="filtered.length === 0">
              <div class="empty">No results found.</div>
            </template>
            <template v-for="group in grouped" :key="group.category">
              <div class="group-label">{{ group.category }}</div>
              <div
                v-for="{ item, globalIndex } in group.items"
                :key="item.id"
                class="item"
                :class="{ selected: globalIndex === selectedIndex }"
                @mouseenter="selectedIndex = globalIndex"
                @click="item.action()"
              >
                <span class="item-icon">{{ item.icon }}</span>
                <span class="item-label">{{ item.label }}</span>
                <span class="item-badge">{{ item.category }}</span>
              </div>
            </template>
          </div>
          <div class="footer-hint">
            <span class="kbd">↑↓</span> navigate
            <span class="kbd">↵</span> select
            <span class="kbd">esc</span> close
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 20vh;
  z-index: 200;
}
.palette {
  width: 500px;
  max-width: 92vw;
  max-height: 400px;
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ---- search bar ---- */
.search-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.search-icon {
  color: var(--text-faint);
  font-size: 14px;
  flex-shrink: 0;
}
.search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 14px;
  font-family: inherit;
}
.search-input::placeholder {
  color: var(--text-faint);
}

/* ---- list ---- */
.list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}
.group-label {
  padding: 6px 16px 4px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 16px;
  cursor: pointer;
  transition: background 0.08s ease;
}
.item.selected {
  background: var(--accent-soft);
}
.item-icon {
  font-size: 14px;
  width: 22px;
  text-align: center;
  flex-shrink: 0;
}
.item-label {
  flex: 1;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item-badge {
  font-size: 10px;
  color: var(--text-faint);
  background: var(--bg-elevated);
  padding: 1px 7px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: 13px;
}

/* ---- footer hint ---- */
.footer-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-faint);
}
.kbd {
  font-family: var(--mono);
  font-size: 10px;
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--border);
}

/* ---- animation ---- */
.palette-enter-active,
.palette-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.palette-enter-active .palette,
.palette-leave-active .palette {
  transition: transform 0.15s ease;
}
.palette-enter-from {
  opacity: 0;
}
.palette-enter-from .palette {
  transform: scale(0.95);
}
.palette-leave-to {
  opacity: 0;
}
.palette-leave-to .palette {
  transform: scale(0.95);
}
</style>
