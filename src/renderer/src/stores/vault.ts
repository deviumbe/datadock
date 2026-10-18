import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { VaultConfigInput, VaultStatus } from '@shared/types'

export const useVault = defineStore('vault', () => {
  const status = ref<VaultStatus | null>(null)
  const loaded = ref(false)
  /** Why the lock screen is showing after a forced lock (re-key elsewhere, etc.). */
  const lockReason = ref('')

  const configured = computed(() => !!status.value?.configured)
  const locked = computed(() => !!status.value?.configured && !status.value.unlocked)

  async function refresh(): Promise<void> {
    try {
      status.value = await window.api.vault.status()
    } catch {
      status.value = null
    } finally {
      loaded.value = true
    }
  }

  async function unlock(passphrase: string, rememberTouchId: boolean): Promise<void> {
    status.value = await window.api.vault.unlock(passphrase, rememberTouchId)
    lockReason.value = ''
  }
  async function unlockTouchId(): Promise<void> {
    status.value = await window.api.vault.unlockTouchId()
    lockReason.value = ''
  }
  async function lock(): Promise<void> {
    status.value = await window.api.vault.lock()
  }
  async function create(path: string, passphrase: string, touchId: boolean): Promise<void> {
    status.value = await window.api.vault.create(path, passphrase, touchId)
  }
  async function open(path: string, passphrase: string, touchId: boolean): Promise<void> {
    status.value = await window.api.vault.open(path, passphrase, touchId)
  }
  async function setConfig(input: VaultConfigInput): Promise<void> {
    status.value = await window.api.vault.setConfig(input)
  }
  function pickLocation(mode: 'create' | 'open'): Promise<string | null> {
    return window.api.vault.pickLocation(mode)
  }

  /** Mirror main-process lock events and external reloads. Returns an unsubscribe. */
  function listen(onChanged: () => void): () => void {
    const offLocked = window.api.vault.onLocked((s) => {
      lockReason.value = s.reason ?? ''
      status.value = s
    })
    const offUnlocked = window.api.vault.onUnlocked((s) => {
      lockReason.value = ''
      status.value = s
    })
    const offChanged = window.api.vault.onChanged((s) => {
      status.value = s
      onChanged()
    })
    return () => {
      offLocked()
      offUnlocked()
      offChanged()
    }
  }

  return {
    status,
    loaded,
    lockReason,
    configured,
    locked,
    refresh,
    unlock,
    unlockTouchId,
    lock,
    create,
    open,
    setConfig,
    pickLocation,
    listen
  }
})
