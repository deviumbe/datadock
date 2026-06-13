import { contextBridge, ipcRenderer } from 'electron'
import type {
  AlterOp,
  ConnectionConfig,
  CreateTableSpec,
  DropTableOptions,
  DumpFormat,
  ErModel,
  ExportFormat,
  ExportPayload,
  FileResult,
  HistoryEntry,
  ImportResult,
  IpcResult,
  Snippet,
  QueryResult,
  RowChangeSet,
  TableDumpSpec,
  TableInfo,
  TableQueryOptions,
  TableStructure,
  Workspace
} from '@shared/types'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!res.ok) throw new Error(res.error)
  return res.data
}

const api = {
  platform: process.platform,
  /** Subscribe to native-menu actions. Returns an unsubscribe function. */
  onMenuAction: (cb: (action: string) => void): (() => void) => {
    const listener = (_e: unknown, action: string): void => cb(action)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  },
  workspace: {
    get: () => invoke<Workspace>('workspace:get'),
    addProject: (name: string) => invoke<Workspace>('workspace:addProject', name),
    renameProject: (id: string, name: string) =>
      invoke<Workspace>('workspace:renameProject', id, name),
    deleteProject: (id: string) => invoke<Workspace>('workspace:deleteProject', id),
    addEnvironment: (projectId: string, name: string) =>
      invoke<Workspace>('workspace:addEnvironment', projectId, name),
    renameEnvironment: (id: string, name: string) =>
      invoke<Workspace>('workspace:renameEnvironment', id, name),
    deleteEnvironment: (id: string) => invoke<Workspace>('workspace:deleteEnvironment', id),
    saveConnection: (environmentId: string, config: ConnectionConfig) =>
      invoke<Workspace>('workspace:saveConnection', environmentId, config),
    deleteConnection: (id: string) => invoke<Workspace>('workspace:deleteConnection', id),
    duplicateConnection: (id: string) => invoke<Workspace>('workspace:duplicateConnection', id)
  },
  db: {
    test: (config: ConnectionConfig) => invoke<boolean>('db:test', config),
    connect: (id: string) => invoke<boolean>('db:connect', id),
    disconnect: (id: string) => invoke<boolean>('db:disconnect', id),
    isConnected: (id: string) => invoke<boolean>('db:isConnected', id),
    listTables: (id: string) => invoke<TableInfo[]>('db:listTables', id),
    tableData: (id: string, table: TableInfo, opts: TableQueryOptions) =>
      invoke<QueryResult>('db:tableData', id, table, opts),
    query: (id: string, sql: string) => invoke<QueryResult>('db:query', id, sql),
    schema: (id: string) => invoke<Record<string, string[]>>('db:schema', id),
    erModel: (id: string) => invoke<ErModel>('db:erModel', id),
    primaryKeys: (id: string, table: TableInfo) => invoke<string[]>('db:primaryKeys', id, table),
    applyChanges: (id: string, table: TableInfo, changes: RowChangeSet) =>
      invoke<number>('db:applyChanges', id, table, changes),
    listDatabases: (id: string) => invoke<string[]>('db:listDatabases', id),
    createDatabase: (id: string, name: string) =>
      invoke<void>('db:createDatabase', id, name),
    dropDatabase: (id: string, name: string) => invoke<void>('db:dropDatabase', id, name),
    listProcesses: (id: string) => invoke<QueryResult>('db:listProcesses', id),
    killProcess: (id: string, pid: string | number) =>
      invoke<void>('db:killProcess', id, pid),
    listUsers: (id: string) => invoke<QueryResult>('db:listUsers', id),
    tableDDL: (id: string, table: TableInfo) => invoke<string>('db:tableDDL', id, table),
    tableStructure: (id: string, table: TableInfo) =>
      invoke<TableStructure>('db:tableStructure', id, table),
    alterTable: (id: string, table: TableInfo, op: AlterOp) =>
      invoke<void>('db:alterTable', id, table, op),
    createTable: (id: string, spec: CreateTableSpec) =>
      invoke<void>('db:createTable', id, spec),
    dropTables: (id: string, tables: TableInfo[], opts: DropTableOptions) =>
      invoke<void>('db:dropTables', id, tables, opts)
  },
  io: {
    exportData: (id: string, format: ExportFormat, payload: ExportPayload) =>
      invoke<FileResult>('io:exportData', id, format, payload),
    exportTable: (id: string, table: TableInfo, format: ExportFormat) =>
      invoke<FileResult>('io:exportTable', id, table, format),
    exportDatabase: (id: string, specs: TableDumpSpec[], format: DumpFormat) =>
      invoke<FileResult>('io:exportDatabase', id, specs, format),
    importSql: (id: string) => invoke<ImportResult & { canceled?: boolean }>('io:importSql', id),
    importCsv: (id: string, table: TableInfo) =>
      invoke<ImportResult & { canceled?: boolean }>('io:importCsv', id, table),
    exportConnections: () => invoke<FileResult>('io:exportConnections'),
    importConnections: () =>
      invoke<{ canceled?: boolean; workspace?: Workspace }>('io:importConnections')
  },
  history: {
    add: (entry: Omit<HistoryEntry, 'id' | 'ranAt'>) => invoke<HistoryEntry>('history:add', entry),
    list: () => invoke<HistoryEntry[]>('history:list'),
    clear: () => invoke<boolean>('history:clear')
  },
  snippets: {
    list: () => invoke<Snippet[]>('snippets:list'),
    save: (input: Partial<Snippet> & { name: string; sql: string }) =>
      invoke<Snippet>('snippets:save', input),
    remove: (id: string) => invoke<boolean>('snippets:remove', id)
  },
  pickFile: () => invoke<string | null>('app:pickFile')
}

export type DataDockApi = typeof api

contextBridge.exposeInMainWorld('api', api)
