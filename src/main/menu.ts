import { app, Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/** Send a UI action to the focused renderer. */
function send(action: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('menu:action', action)
}

export function buildMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Query Tab', accelerator: 'CmdOrCtrl+T', click: () => send('newQuery') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('closeTab') },
        { type: 'separator' },
        { label: 'Import…', click: () => send('import') },
        { label: 'Export Database…', click: () => send('exportDb') },
        { type: 'separator' },
        { label: 'Export Connections…', click: () => send('exportConnections') },
        { label: 'Import Connections…', click: () => send('importConnections') },
        ...(isMac ? [] : [{ type: 'separator' } as const, { role: 'quit' } as const])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        // registerAccelerator:false → the shortcut shows in the menu but the
        // keystroke flows to the web content (CodeMirror / inputs / grid undo).
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          registerAccelerator: false,
          click: () => send('undo')
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          registerAccelerator: false,
          click: () => send('redo')
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Save Changes', accelerator: 'CmdOrCtrl+S', click: () => send('save') }
      ]
    },
    {
      label: 'Database',
      submenu: [
        { label: 'Reload Tables', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('refreshTables') },
        { type: 'separator' },
        { label: 'Databases', click: () => send('databases') },
        { label: 'Users & Roles', click: () => send('users') },
        { label: 'Process List', click: () => send('processes') },
        { label: 'Query History', accelerator: 'CmdOrCtrl+Y', click: () => send('history') },
        { label: 'Saved Queries', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('snippets') },
        { label: 'ER Diagram', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('diagram') },
        { type: 'separator' },
        { label: 'Import…', click: () => send('import') },
        { label: 'Export Database…', click: () => send('exportDb') },
        { type: 'separator' },
        { label: 'Disconnect', click: () => send('disconnect') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('toggleSidebar') },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('toggleTheme') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' } as const, { role: 'front' } as const]
          : [{ role: 'close' } as const])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
