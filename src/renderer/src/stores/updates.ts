import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Auto-update state, driven by main-process electron-updater events.
 *
 * `status` flow:
 *   hidden → available → downloading → ready          (happy path)
 *           ↘ checking → (none | available | failed)  (manual "Check for updates")
 *   downloading → failed                              (e.g. unsigned macOS install)
 *
 * Background (startup) check failures are swallowed — we only surface an error
 * once the user has actively asked to update or check.
 */
export type UpdateStatus =
  | 'hidden'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'failed'
  | 'uptodate'

export const useUpdates = defineStore('updates', () => {
  const status = ref<UpdateStatus>('hidden')
  const version = ref('')
  const progress = ref(0)
  const error = ref('')
  /** True while the user explicitly asked (so we may show "up to date"/errors). */
  const manual = ref(false)

  let wired = false
  function init(): void {
    if (wired) return
    wired = true
    window.api.updates.onAvailable((v) => {
      version.value = v
      // Don't stomp an in-progress download if a second event arrives.
      if (status.value === 'hidden' || status.value === 'checking' || status.value === 'uptodate') {
        status.value = 'available'
      }
    })
    window.api.updates.onNone(() => {
      if (manual.value) {
        status.value = 'uptodate'
        manual.value = false
      }
    })
    window.api.updates.onProgress((p) => {
      progress.value = p
      if (status.value === 'available') status.value = 'downloading'
    })
    window.api.updates.onDownloaded((v) => {
      version.value = v
      status.value = 'ready'
    })
    window.api.updates.onError((msg) => {
      // Only show errors the user can act on (during a manual check or update).
      if (status.value === 'downloading' || status.value === 'checking' || manual.value) {
        error.value = msg
        status.value = 'failed'
        manual.value = false
      }
    })
  }

  function checkManually(): void {
    manual.value = true
    status.value = 'checking'
    window.api.updates.check()
  }
  function download(): void {
    status.value = 'downloading'
    progress.value = 0
    window.api.updates.download()
  }
  function install(): void {
    window.api.updates.install()
  }
  function openReleases(): void {
    window.api.updates.openReleases()
  }
  function dismiss(): void {
    status.value = 'hidden'
    error.value = ''
  }

  return {
    status,
    version,
    progress,
    error,
    init,
    checkManually,
    download,
    install,
    openReleases,
    dismiss
  }
})
