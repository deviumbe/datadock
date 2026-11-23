import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Development-only activity log at `<project>/.debug/datadock.log`, so whoever is
 * debugging (a person or Claude tailing the file) can follow background tasks,
 * failed statements and errors live. A no-op in packaged builds.
 *
 * Never pass connection configs or other secrets in here.
 */
const enabled = !!process.env.ELECTRON_RENDERER_URL
const MAX_BYTES = 20 * 1024 * 1024

let file: string | null = null

function logFile(): string {
  if (file) return file
  const dir = join(app.getAppPath(), '.debug')
  mkdirSync(dir, { recursive: true })
  file = join(dir, 'datadock.log')
  try {
    if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
  } catch {
    /* no log yet */
  }
  return file
}

export function debugLog(scope: string, message: string): void {
  if (!enabled) return
  try {
    appendFileSync(logFile(), `${new Date().toISOString()} [${scope}] ${message}\n`)
  } catch {
    /* logging must never break the app */
  }
}

/** Log at most once per `intervalMs` per key; for chatty sources like progress. */
export function throttledDebugLog(intervalMs: number): (key: string, scope: string, message: string) => void {
  const last = new Map<string, number>()
  return (key, scope, message) => {
    const now = Date.now()
    if (now - (last.get(key) ?? 0) < intervalMs) return
    last.set(key, now)
    debugLog(scope, message)
  }
}
