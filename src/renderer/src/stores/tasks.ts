import { defineStore } from 'pinia'
import { reactive, computed } from 'vue'
import type { IoProgress } from '@shared/types'

export type TaskKind = 'export' | 'transfer' | 'import'
export type TaskStatus = 'running' | 'done' | 'error' | 'canceled'

export interface BgTask {
  id: string
  kind: TaskKind
  title: string
  status: TaskStatus
  progress: IoProgress | null
  message?: string
  errors?: string[]
  startedAt: number
  finishedAt?: number
}

/** Result a task runner may return to summarize the outcome. */
export interface TaskResult {
  message?: string
  errors?: string[]
  canceled?: boolean
}

export const useTasks = defineStore('tasks', () => {
  const tasks = reactive<BgTask[]>([])
  const running = computed(() => tasks.filter((t) => t.status === 'running'))
  const hasActive = computed(() => running.value.length > 0)

  // Single global progress listener routes each event to its task by op id.
  window.api.io.onProgress((p) => {
    const t = tasks.find((t) => t.id === p.opId)
    if (t && t.status === 'running') t.progress = p
  })

  /**
   * Run a long operation in the background. `run` receives the op id, which it
   * MUST forward to the underlying IPC call so progress/cancel route correctly.
   */
  function start(opts: {
    kind: TaskKind
    title: string
    run: (opId: string) => Promise<TaskResult | void>
  }): string {
    const id = crypto.randomUUID()
    // reactive() so the closures below mutate the tracked proxy, not a raw object
    // (a raw mutation wouldn't re-render the tray until something else forces it).
    const task = reactive<BgTask>({
      id,
      kind: opts.kind,
      title: opts.title,
      status: 'running',
      progress: null,
      startedAt: Date.now()
    })
    tasks.unshift(task)
    opts
      .run(id)
      .then(
        (res) => {
          task.status = res?.canceled ? 'canceled' : 'done'
          task.message = res?.message
          task.errors = res?.errors
        },
        (e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e)
          task.status = msg === 'Canceled' ? 'canceled' : 'error'
          task.message = msg
        }
      )
      .finally(() => {
        task.progress = null
        task.finishedAt = Date.now()
        // Tidy up: drop dialog-cancelled no-ops automatically.
        if (task.status === 'canceled' && !task.message) dismiss(id)
      })
    return id
  }

  function cancel(id: string): void {
    const t = tasks.find((t) => t.id === id)
    if (!t || t.status !== 'running') return
    t.message = 'Canceling…'
    void window.api.io.cancel(id)
  }

  function dismiss(id: string): void {
    const i = tasks.findIndex((t) => t.id === id)
    if (i !== -1) tasks.splice(i, 1)
  }

  function clearFinished(): void {
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (tasks[i].status !== 'running') tasks.splice(i, 1)
    }
  }

  return { tasks, running, hasActive, start, cancel, dismiss, clearFinished }
})
