import { ipcMain, dialog } from 'electron'
import type {
  AlterOp,
  ConnectionConfig,
  DumpFormat,
  ExportFormat,
  ExportPayload,
  IpcResult,
  RowChangeSet,
  TableDumpSpec,
  TableInfo,
  TableQueryOptions
} from '@shared/types'
import type { HistoryEntry } from '@shared/types'
import * as store from './storage'
import * as db from './db'
import * as io from './io'
import * as history from './history'

type Handler<T> = (...args: any[]) => Promise<T> | T

/** Register a handler that always resolves to an IpcResult envelope. */
function handle<T>(channel: string, fn: Handler<T>): void {
  ipcMain.handle(channel, async (_evt, ...args): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

export function registerIpc(): void {
  // Workspace tree
  handle('workspace:get', () => store.workspaceForRenderer())
  handle('workspace:addProject', (name: string) => store.addProject(name))
  handle('workspace:renameProject', (id: string, name: string) => store.renameProject(id, name))
  handle('workspace:deleteProject', (id: string) => store.deleteProject(id))
  handle('workspace:addEnvironment', (projectId: string, name: string) =>
    store.addEnvironment(projectId, name)
  )
  handle('workspace:renameEnvironment', (id: string, name: string) =>
    store.renameEnvironment(id, name)
  )
  handle('workspace:deleteEnvironment', (id: string) => store.deleteEnvironment(id))
  handle('workspace:saveConnection', (environmentId: string, config: ConnectionConfig) =>
    store.saveConnection(environmentId, config)
  )
  handle('workspace:deleteConnection', (id: string) => store.deleteConnection(id))

  // Database operations
  handle('db:test', async (config: ConnectionConfig) => {
    await db.testConnection(store.resolveFormConfig(config))
    return true
  })
  handle('db:connect', async (id: string) => {
    await db.connect(store.resolveConnection(id))
    return true
  })
  handle('db:disconnect', async (id: string) => {
    await db.disconnect(id)
    return true
  })
  handle('db:isConnected', (id: string) => db.isConnected(id))
  handle('db:listTables', (id: string) => db.getAdapter(id).listTables())
  handle('db:tableData', (id: string, table: TableInfo, opts: TableQueryOptions) =>
    db.getAdapter(id).tableData(table, opts)
  )
  handle('db:query', (id: string, sql: string) => db.getAdapter(id).query(sql))
  handle('db:schema', (id: string) => db.capability(id, 'schema')())
  handle('db:primaryKeys', (id: string, table: TableInfo) =>
    db.capability(id, 'primaryKeys')(table)
  )
  handle('db:applyChanges', (id: string, table: TableInfo, changes: RowChangeSet) =>
    db.capability(id, 'applyChanges')(table, changes)
  )

  // Server-level management
  handle('db:listDatabases', (id: string) => db.capability(id, 'listDatabases')())
  handle('db:createDatabase', (id: string, name: string) =>
    db.capability(id, 'createDatabase')(name)
  )
  handle('db:dropDatabase', (id: string, name: string) => db.capability(id, 'dropDatabase')(name))
  handle('db:listProcesses', (id: string) => db.capability(id, 'listProcesses')())
  handle('db:killProcess', (id: string, pid: string | number) =>
    db.capability(id, 'killProcess')(pid)
  )
  handle('db:listUsers', (id: string) => db.capability(id, 'listUsers')())
  handle('db:tableDDL', (id: string, table: TableInfo) => db.capability(id, 'tableDDL')(table))
  handle('db:tableStructure', (id: string, table: TableInfo) =>
    db.capability(id, 'tableStructure')(table)
  )
  handle('db:alterTable', (id: string, table: TableInfo, op: AlterOp) =>
    db.capability(id, 'alterTable')(table, op)
  )

  // Import / export
  handle('io:exportData', (id: string, format: ExportFormat, payload: ExportPayload) =>
    io.exportData(id, format, payload)
  )
  handle('io:exportTable', (id: string, table: TableInfo, format: ExportFormat) =>
    io.exportTable(id, table, format)
  )
  handle('io:exportDatabase', (id: string, specs: TableDumpSpec[], format: DumpFormat) =>
    io.exportDatabase(id, specs, format)
  )
  handle('io:importSql', (id: string) => io.importSql(id))
  handle('io:importCsv', (id: string, table: TableInfo) => io.importCsv(id, table))

  // Query history
  handle('history:add', (entry: Omit<HistoryEntry, 'id' | 'ranAt'>) => history.addHistory(entry))
  handle('history:list', () => history.listHistory())
  handle('history:clear', () => {
    history.clearHistory()
    return true
  })

  // File picker (e.g. SSH private key)
  handle('app:pickFile', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'] })
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })
}
