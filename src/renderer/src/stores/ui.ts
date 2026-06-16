import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUi = defineStore('ui', () => {
  const sidebarCollapsed = ref(false)
  const tablesCollapsed = ref(false)
  const autoCollapsedOnce = ref(false)

  // Menu-triggered modals (rendered by MainPanel).
  const importOpen = ref(false)
  const exportDbOpen = ref(false)
  const tableSizesOpen = ref(false)
  const columnSearchOpen = ref(false)

  // Command palette
  const paletteOpen = ref(false)
  function openPalette(): void { paletteOpen.value = true }
  function closePalette(): void { paletteOpen.value = false }
  function togglePalette(): void { paletteOpen.value = !paletteOpen.value }

  const isMac = window.api?.platform === 'darwin'

  // Theme (persisted to localStorage; applied to <html data-theme>).
  const theme = ref<'dark' | 'light'>(
    (localStorage.getItem('datadock-theme') as 'dark' | 'light') || 'dark'
  )
  function applyTheme(): void {
    document.documentElement.setAttribute('data-theme', theme.value)
  }
  function toggleTheme(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
    localStorage.setItem('datadock-theme', theme.value)
    applyTheme()
  }
  applyTheme()

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
    importOpen,
    exportDbOpen,
    tableSizesOpen,
    columnSearchOpen,
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
