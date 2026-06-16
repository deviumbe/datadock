import { ipcMain, dialog } from 'electron'
import type {
  AlterOp,
  ConnectionConfig,
  CreateTableSpec,
  DropTableOptions,
  DumpFormat,
  ExportFormat,
  ExportPayload,
  IpcResult,
  RowChangeSet,
  TableDumpSpec,
  TableInfo,
  TableQueryOptions
} from '@shared/types'
import type { HistoryEntry, Snippet } from '@shared/types'
import * as store from './storage'
import * as db from './db'
import * as io from './io'
import * as history from './history'
import * as snippets from './snippets'
import * as ai from './ai'

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
  handle('workspace:duplicateConnection', (id: string) => store.duplicateConnection(id))

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
  handle('db:explainPlan', (id: string, sql: string) => db.explainPlan(id, sql))
  handle('db:txnBegin', (id: string) => db.capability(id, 'beginTransaction')())
  handle('db:txnCommit', (id: string) => db.capability(id, 'commitTransaction')())
  handle('db:txnRollback', (id: string) => db.capability(id, 'rollbackTransaction')())
  handle('db:schema', (id: string) => db.capability(id, 'schema')())
  handle('db:erModel', (id: string) => db.capability(id, 'erModel')())
  handle('db:schemaSnapshot', (id: string) => db.capability(id, 'schemaSnapshot')())
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
  handle('db:createTable', (id: string, spec: CreateTableSpec) =>
    db.capability(id, 'createTable')(spec)
  )
  handle('db:dropTables', (id: string, tables: TableInfo[], opts: DropTableOptions) =>
    db.capability(id, 'dropTables')(tables, opts)
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
  handle('io:exportConnections', () => io.exportConnections())
  handle('io:importConnections', () => io.importConnections())
  handle('io:saveFile', (name: string, data: string, binary: boolean) =>
    io.saveFile(name, data, binary)
  )

  // Query history
  handle('history:add', (entry: Omit<HistoryEntry, 'id' | 'ranAt'>) => history.addHistory(entry))
  handle('history:list', () => history.listHistory())
  handle('history:clear', () => {
    history.clearHistory()
    return true
  })

  // Saved queries / snippets
  handle('snippets:list', () => snippets.listSnippets())
  handle('snippets:save', (input: Partial<Snippet> & { name: string; sql: string }) =>
    snippets.saveSnippet(input)
  )
  handle('snippets:remove', (id: string) => {
    snippets.removeSnippet(id)
    return true
  })

  // AI SQL assistant (key held + used only in main; never sent to renderer)
  handle('ai:hasKey', () => ai.hasAiKey())
  handle('ai:setKey', (key: string) => ai.setAiKey(key))
  handle('ai:clearKey', () => ai.clearAiKey())
  handle('ai:generateSql', (req: ai.AiSqlRequest) => ai.generateSql(req))
  handle('ai:explainQuery', (req: ai.AiExplainRequest) => ai.explainQuery(req))
  handle('ai:fixQuery', (req: ai.AiFixRequest) => ai.fixQuery(req))

  // File picker (e.g. SSH private key)
  handle('app:pickFile', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'] })
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })
}
