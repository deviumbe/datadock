import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { ThemeColors, ThemeSettings } from '@shared/types'
import { DEFAULT_THEME } from '@shared/themeDefaults'
import { applyTheme, resolveTheme, CUSTOM_ID, type Mode } from '../lib/theme'

const CACHE_KEY = 'datadock-theme-settings'
const LEGACY_KEY = 'datadock-theme'

// The persisted copy lives in settings.json (main process); a localStorage
// mirror lets the first paint use the right theme before IPC answers.
function readCache(): ThemeSettings {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) return { ...DEFAULT_THEME, ...(JSON.parse(raw) as Partial<ThemeSettings>) }
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy === 'light' || legacy === 'dark') return { ...DEFAULT_THEME, mode: legacy }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_THEME }
}

export const useTheme = defineStore('theme', () => {
  const settings = ref<ThemeSettings>(readCache())
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const systemDark = ref(media.matches)
  media.addEventListener('change', (e) => (systemDark.value = e.matches))

  const mode = computed<Mode>(() =>
    settings.value.mode === 'system' ? (systemDark.value ? 'dark' : 'light') : settings.value.mode
  )
  const preset = computed(() => resolveTheme(settings.value, mode.value))
  const activePresetId = computed(() =>
    mode.value === 'dark' ? settings.value.darkPreset : settings.value.lightPreset
  )
  const customColors = computed<ThemeColors | undefined>(() =>
    mode.value === 'dark' ? settings.value.customDark : settings.value.customLight
  )
  const isCustom = computed(() => activePresetId.value === CUSTOM_ID && !!customColors.value)

  watch(
    [settings, mode],
    () => {
      const applied = applyTheme(settings.value, mode.value)
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(settings.value))
      } catch {
        /* storage full or unavailable */
      }
      void window.api?.setWindowBackground?.(applied.background)
    },
    { deep: true, immediate: true }
  )

  /** Adopt the copy loaded from settings.json without writing it back. */
  function hydrate(t: ThemeSettings | undefined): void {
    if (!t) return
    const next = { ...DEFAULT_THEME, ...t }
    if (JSON.stringify(next) !== JSON.stringify(settings.value)) settings.value = next
  }

  async function update(partial: Partial<ThemeSettings>): Promise<void> {
    settings.value = { ...settings.value, ...partial }
    try {
      await window.api.settings.setAppearance({ theme: settings.value })
    } catch {
      /* main unavailable — the localStorage mirror still holds the choice */
    }
  }

  function toggle(): Promise<void> {
    return update({ mode: mode.value === 'dark' ? 'light' : 'dark' })
  }

  function selectPreset(id: string): Promise<void> {
    return update(mode.value === 'dark' ? { darkPreset: id } : { lightPreset: id })
  }

  /** Fork the current preset into an editable custom theme for this mode. */
  function customize(): Promise<void> {
    const colors = { ...preset.value.colors }
    return update(
      mode.value === 'dark'
        ? { darkPreset: CUSTOM_ID, customDark: colors }
        : { lightPreset: CUSTOM_ID, customLight: colors }
    )
  }

  function setCustomColor(key: keyof ThemeColors, value: string): Promise<void> {
    const base = customColors.value ?? { ...preset.value.colors }
    const colors = { ...base, [key]: value }
    return update(mode.value === 'dark' ? { customDark: colors } : { customLight: colors })
  }

  return {
    settings,
    mode,
    preset,
    activePresetId,
    customColors,
    isCustom,
    hydrate,
    update,
    toggle,
    selectPreset,
    customize,
    setCustomColor
  }
})
