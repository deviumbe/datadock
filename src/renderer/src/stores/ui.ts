import { defineStore } from 'pinia'
import { useTheme } from './theme'
import { ref, computed } from 'vue'

/** Options for the in-app confirm modal (dangerous-query guard, etc.). */
export interface ConfirmOpts {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}

export const useUi = defineStore('ui', () => {
  const sidebarCollapsed = ref(false)
  const tablesCollapsed = ref(false)
  const autoCollapsedOnce = ref(false)

  // User-resizable panel widths (persisted). Clamped to sane ranges on set.
  const num = (key: string, fallback: number): number => {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  const tablesWidth = ref(num('datadock-tables-w', 210))
  const detailWidth = ref(num('datadock-detail-w', 320))
  function setTablesWidth(px: number): void {
    tablesWidth.value = Math.max(160, Math.min(440, Math.round(px)))
    localStorage.setItem('datadock-tables-w', String(tablesWidth.value))
  }
  function setDetailWidth(px: number): void {
    detailWidth.value = Math.max(240, Math.min(640, Math.round(px)))
    localStorage.setItem('datadock-detail-w', String(detailWidth.value))
  }

  // Menu-triggered modals (rendered by MainPanel).
  const importOpen = ref(false)
  const exportDbOpen = ref(false)
  const transferOpen = ref(false)
  const tableSizesOpen = ref(false)
  const columnSearchOpen = ref(false)
  const snapshotsOpen = ref(false)
  const recoverOpen = ref(false)
  const cloneSqliteOpen = ref(false)
  const settingsOpen = ref(false)
  const dataGripImportOpen = ref(false)

  // Replication topology monitor (full-window overlay view).
  const topologyId = ref<string | null>(null)
  function openTopology(id: string): void { topologyId.value = id }
  function closeTopology(): void { topologyId.value = null }

  // AI chat dock (slide-out panel on the right; works without a query tab)
  const chatDockOpen = ref(false)
  function openChatDock(): void { chatDockOpen.value = true }
  function toggleChatDock(): void { chatDockOpen.value = !chatDockOpen.value }

  // Reusable confirmation dialog (async). Replaces window.confirm with an
  // on-brand modal; awaited by callers like the dangerous-query guard.
  const confirmState = ref<(ConfirmOpts & { resolve: (ok: boolean) => void }) | null>(null)
  function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      confirmState.value = { ...opts, resolve }
    })
  }
  function resolveConfirm(ok: boolean): void {
    confirmState.value?.resolve(ok)
    confirmState.value = null
  }

  // Command palette
  const paletteOpen = ref(false)
  function openPalette(): void { paletteOpen.value = true }
  function closePalette(): void { paletteOpen.value = false }
  function togglePalette(): void { paletteOpen.value = !paletteOpen.value }

  const isMac = window.api?.platform === 'darwin'

  // Theme lives in the theme store; these stay as the façade the rest of the
  // UI already calls (resolved mode + toggle).
  const themeStore = useTheme()
  const theme = computed(() => themeStore.mode)
  function toggleTheme(): void {
    void themeStore.toggle()
  }

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }
  function toggleTables(): void {
    tablesCollapsed.value = !tablesCollapsed.value
  }
  /** Collapse the project sidebar the first time a connection opens. */
  function autoCollapseOnConnect(): void {
    if (!autoCollapsedOnce.value) {
      sidebarCollapsed.value = true
      autoCollapsedOnce.value = true
    }
  }

  return {
    sidebarCollapsed,
    tablesCollapsed,
    tablesWidth,
    detailWidth,
    setTablesWidth,
    setDetailWidth,
    importOpen,
    exportDbOpen,
    transferOpen,
    tableSizesOpen,
    columnSearchOpen,
    snapshotsOpen,
    recoverOpen,
    cloneSqliteOpen,
    settingsOpen,
    dataGripImportOpen,
    topologyId,
    openTopology,
    closeTopology,
    chatDockOpen,
    openChatDock,
    toggleChatDock,
    confirmState,
    confirmDialog,
    resolveConfirm,
    paletteOpen,
    openPalette,
    closePalette,
    togglePalette,
    isMac,
    theme,
    toggleTheme,
    toggleSidebar,
    toggleTables,
    autoCollapseOnConnect
  }
})
