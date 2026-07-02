import { app, BrowserWindow, shell, nativeImage, powerMonitor } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'

// Large database clones/dumps push a lot of transient data through the main
// process; give V8's old space generous headroom so a big transfer can't trip
// the default ~4 GB ceiling mid-run. Must be set before the app is ready.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192')
import { startScheduler } from './scheduler'
import { loadWorkspace } from './storage'
import { disconnectAll, verifyAll } from './db'
import { startMcp, stopMcp } from './mcp'
import { buildMenu } from './menu'
import { setupUpdater } from './updater'

// NOTE: we deliberately do NOT call app.setName('DataDock') here. On macOS,
// safeStorage derives its keychain encryption key from the app name, so renaming
// the running app would make previously-encrypted connection secrets undecryptable.
// The packaged app is named "DataDock" via electron-builder (productName); in
// development macOS shows "Electron", which is only a cosmetic dev artifact.
// The About panel is still branded via setAboutPanelOptions below.

const isDev = !!process.env.ELECTRON_RENDERER_URL
const iconPath = join(__dirname, '../../resources/icon.png')

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#1b1d23',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'DataDock',
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // Returning to the app is a strong cue to re-check connections (the laptop
  // may have slept, or an idle tunnel timed out while we were away).
  win.on('focus', () => void verifyAll())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: 'DataDock',
    applicationVersion: `Version ${app.getVersion()}`,
    version: '',
    copyright: 'Free to use · © Devium',
    credits:
      'A project-organized database client for PostgreSQL, MySQL, SQLite, SQL Server & InfluxDB.\n\nMade by Devium (https://devium.be) — free of charge.'
  })

  if (process.platform === 'darwin' && app.dock) {
    const img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) app.dock.setIcon(img)
  }
  // Waking from sleep is the most common cause of a "green but dead" socket.
  powerMonitor.on('resume', () => void verifyAll())

  loadWorkspace()
  registerIpc()
  buildMenu()
  startScheduler()
  // Start the MCP server only if the user previously enabled it (kill-switch).
  startMcp()
  const win = createWindow()
  setupUpdater(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) setupUpdater(createWindow())
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  stopMcp()
  await disconnectAll()
})
