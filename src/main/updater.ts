import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

/** Public releases page — used as a fallback when in-app install isn't possible. */
const RELEASES_URL = 'https://github.com/deviumbe/datadock/releases/latest'

let ipcReady = false

/**
 * Wire up GitHub-backed auto-updates. electron-builder writes `app-update.yml`
 * from the `publish` config in package.json, and the release workflow uploads the
 * `latest*.yml` metadata, so electron-updater can compare the running version to
 * the newest published release and download the matching installer.
 *
 * We use `autoDownload = false` so the user sees a "new version — update" prompt
 * first (their explicit ask), then downloads on click. Updates only run in a
 * packaged app; in dev there's nothing to update against.
 *
 * Platform note: Windows (NSIS) and Linux (AppImage) install in-app out of the
 * box. macOS auto-install requires the app to be code-signed (Squirrel.Mac
 * verifies the signature); until then the renderer falls back to opening the
 * releases page on the `error` path.
 */
export function setupUpdater(win: BrowserWindow): void {
  registerUpdaterIpc()
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  const send = (channel: string, payload?: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  autoUpdater.on('update-available', (info) => send('update:available', { version: info.version }))
  autoUpdater.on('update-not-available', () => send('update:none'))
  autoUpdater.on('download-progress', (p) => send('update:progress', Math.round(p.percent)))
  autoUpdater.on('update-downloaded', (info) => send('update:downloaded', { version: info.version }))
  autoUpdater.on('error', (err) =>
    send('update:error', err instanceof Error ? err.message : String(err))
  )

  // Check shortly after launch so the window is ready to show a prompt.
  setTimeout(() => void autoUpdater.checkForUpdates()?.catch(() => {}), 3000)
}

/** Register the renderer→main update actions (once). */
function registerUpdaterIpc(): void {
  if (ipcReady) return
  ipcReady = true

  ipcMain.on('update:check', () => void autoUpdater.checkForUpdates()?.catch(() => {}))
  ipcMain.on('update:download', () => void autoUpdater.downloadUpdate()?.catch(() => {}))
  ipcMain.on('update:install', () => autoUpdater.quitAndInstall())
  ipcMain.on('update:openReleases', () => void shell.openExternal(RELEASES_URL))
}
