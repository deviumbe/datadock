import { app, BrowserWindow, shell, nativeImage } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { loadWorkspace } from './storage'
import { disconnectAll } from './db'
import { buildMenu } from './menu'

// NOTE: we deliberately do NOT call app.setName('DataDock') here. On macOS,
// safeStorage derives its keychain encryption key from the app name, so renaming
// the running app would make previously-encrypted connection secrets undecryptable.
// The packaged app is named "DataDock" via electron-builder (productName); in
// development macOS shows "Electron", which is only a cosmetic dev artifact.
// The About panel is still branded via setAboutPanelOptions below.

const isDev = !!process.env.ELECTRON_RENDERER_URL
const iconPath = join(__dirname, '../../resources/icon.png')

function createWindow(): void {
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

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
  loadWorkspace()
  registerIpc()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await disconnectAll()
})
