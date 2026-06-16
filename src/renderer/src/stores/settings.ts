import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AiProvider, AppSettings, AppearanceSettings, ProviderInfo } from '@shared/types'

export const useSettings = defineStore('settings', () => {
  const data = ref<AppSettings | null>(null)
  const loaded = ref(false)

  function apply(s: AppSettings): void {
    data.value = s
    // Interface scale via Electron zoom factor + density attribute for CSS.
    window.api.setZoom?.(s.appearance.fontScale)
    document.documentElement.setAttribute('data-density', s.appearance.density)
  }

  async function load(): Promise<void> {
    try {
      apply(await window.api.settings.get())
    } catch {
      /* settings unavailable — fall back to defaults already in CSS/zoom */
    } finally {
      loaded.value = true
    }
  }

  const providers = computed<ProviderInfo[]>(() => data.value?.ai.providers ?? [])
  const activeProvider = computed<AiProvider>(() => data.value?.ai.activeProvider ?? 'anthropic')
  const appearance = computed<AppearanceSettings>(
    () => data.value?.appearance ?? { fontScale: 1, density: 'comfortable', pageSize: 200, theme: 'dark' }
  )
  const pageSize = computed(() => appearance.value.pageSize)
  /** The active provider is usable (has a key, or is keyless like Ollama). */
  const aiReady = computed(() => {
    const p = providers.value.find((x) => x.provider === activeProvider.value)
    return !!p && (!p.needsKey || p.hasKey)
  })

  async function setActiveProvider(p: AiProvider): Promise<void> {
    apply(await window.api.settings.setActiveProvider(p))
  }
  async function setProviderKey(p: AiProvider, key: string): Promise<void> {
    apply(await window.api.settings.setProviderKey(p, key))
  }
  async function clearProviderKey(p: AiProvider): Promise<void> {
    apply(await window.api.settings.clearProviderKey(p))
  }
  async function setProviderConfig(
    p: AiProvider,
    cfg: { model?: string; baseUrl?: string }
  ): Promise<void> {
    apply(await window.api.settings.setProviderConfig(p, cfg))
  }
  async function setAppearance(a: Partial<AppearanceSettings>): Promise<void> {
    apply(await window.api.settings.setAppearance(a))
  }
  function testProvider(p: AiProvider): Promise<boolean> {
    return window.api.settings.testProvider(p)
  }

  return {
    data,
    loaded,
    load,
    providers,
    activeProvider,
    appearance,
    pageSize,
    aiReady,
    setActiveProvider,
    setProviderKey,
    clearProviderKey,
    setProviderConfig,
    setAppearance,
    testProvider
  }
})
