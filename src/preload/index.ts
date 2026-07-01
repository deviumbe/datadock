import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { MaskConfig } from '@shared/mask'
import type {
  AiProvider,
  AnalyticsChart,
  AnalyticsDashboard,
  AnalyticsDataset,
  AnalyticsMetric,
  AnalyticsPlan,
  AnalyticsState,
  ScheduledReport,
  AppearanceSettings,
  AppSettings,
  McpInfo,
  McpSettings,
  ChatMessage,
  ChatStep,
  AlterOp,
  ConnectionConfig,
  CreateTableSpec,
  DropTableOptions,
  TruncateOptions,
  DumpFormat,
  ErModel,
  SchemaSnapshot,
  ExportFormat,
  ExportPayload,
  CloneOptions,
  CloneResult,
  FileResult,
  HistoryEntry,
  ImportResult,
  IpcResult,
  PlanBaseline,
  PlanNode,
  RowVersion,
  RowVersionInput,
  PoolStats,
  QueueAction,
  QueueJob,
  QueueJobState,
  QueueOverview,
  RedisKeyValue,
  RedisServerStats,
  SizeSnapshot,
  Snippet,
  Snapshot,
  Bookmark,
  RestoreResult,
  QueryResult,
  RowChangeSet,
  TableDumpSpec,
  TableInfo,
  TableQueryOptions,
  TableSizeInfo,
  TableStructure,
  Topology,
  ReplicationStatus,
  InvestigationType,
  InvestigationReport,
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
    duplicateConnection: (id: string) => invoke<Workspace>('workspace:duplicateConnection', id),
    saveTopology: (topology: Topology) => invoke<Workspace>('workspace:saveTopology', topology),
    deleteTopology: (id: string) => invoke<Workspace>('workspace:deleteTopology', id)
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
    cancelQuery: (id: string) => invoke<void>('db:cancelQuery', id),
    countRows: (id: string, table: TableInfo, opts: TableQueryOptions) =>
      invoke<number>('db:countRows', id, table, opts),
    explainPlan: (id: string, sql: string) =>
      invoke<PlanNode | null>('db:explainPlan', id, sql),
    replicationStatus: (id: string) =>
      invoke<ReplicationStatus>('db:replicationStatus', id),
    txnBegin: (id: string) => invoke<void>('db:txnBegin', id),
    txnCommit: (id: string) => invoke<void>('db:txnCommit', id),
    txnRollback: (id: string) => invoke<void>('db:txnRollback', id),
    schema: (id: string) => invoke<Record<string, string[]>>('db:schema', id),
    tableSizes: (id: string) => invoke<TableSizeInfo[]>('db:tableSizes', id),
    erModel: (id: string) => invoke<ErModel>('db:erModel', id),
    poolStats: (id: string) => invoke<PoolStats>('db:poolStats', id),
    schemaSnapshot: (id: string) => invoke<SchemaSnapshot>('db:schemaSnapshot', id),
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
      invoke<void>('db:dropTables', id, tables, opts),
    truncateTables: (id: string, tables: TableInfo[], opts: TruncateOptions) =>
      invoke<void>('db:truncateTables', id, tables, opts)
  },
  redis: {
    keyValue: (id: string, key: string) => invoke<RedisKeyValue>('redis:keyValue', id, key),
    serverStats: (id: string) => invoke<RedisServerStats>('redis:serverStats', id),
    queues: (id: string) => invoke<QueueOverview[]>('redis:queues', id),
    queueJobs: (id: string, queue: string, state: QueueJobState, offset: number, limit: number) =>
      invoke<QueueJob[]>('redis:queueJobs', id, queue, state, offset, limit),
    queueAction: (
      id: string,
      action: QueueAction,
      queue: string,
      state: QueueJobState,
      jobId?: string
    ) => invoke<void>('redis:queueAction', id, action, queue, state, jobId)
  },
  io: {
    exportData: (id: string, format: ExportFormat, payload: ExportPayload) =>
      invoke<FileResult>('io:exportData', id, format, payload),
    exportTable: (id: string, table: TableInfo, format: ExportFormat) =>
      invoke<FileResult>('io:exportTable', id, table, format),
    exportDatabase: (id: string, specs: TableDumpSpec[], format: DumpFormat, maskConfig?: MaskConfig) =>
      invoke<FileResult>('io:exportDatabase', id, specs, format, maskConfig),
    importSql: (id: string) => invoke<ImportResult & { canceled?: boolean }>('io:importSql', id),
    importCsv: (id: string, table: TableInfo) =>
      invoke<ImportResult & { canceled?: boolean }>('io:importCsv', id, table),
    exportConnections: () => invoke<FileResult>('io:exportConnections'),
    importConnections: () =>
      invoke<{ canceled?: boolean; workspace?: Workspace }>('io:importConnections'),
    saveFile: (name: string, data: string, binary: boolean) =>
      invoke<FileResult>('io:saveFile', name, data, binary),
    exportPdf: (name: string, html: string, landscape?: boolean) =>
      invoke<FileResult>('io:exportPdf', name, html, landscape),
    pickFolder: () => invoke<FileResult>('io:pickFolder')
  },
  clone: {
    toSqlite: (id: string, opts: CloneOptions) =>
      invoke<CloneResult>('clone:toSqlite', id, opts)
  },
  planBaselines: {
    get: (id: string, sql: string) =>
      invoke<PlanBaseline | null>('planBaselines:get', id, sql),
    set: (id: string, sql: string, cost: number, rows?: number) =>
      invoke<PlanBaseline>('planBaselines:set', id, sql, cost, rows),
    remove: (id: string, sql: string) => invoke<boolean>('planBaselines:remove', id, sql)
  },
  rowHistory: {
    record: (id: string, entries: RowVersionInput[]) =>
      invoke<void>('rowHistory:record', id, entries),
    list: (id: string, table: string, pk: Record<string, unknown>) =>
      invoke<RowVersion[]>('rowHistory:list', id, table, pk),
    clear: (id: string, table?: string) => invoke<void>('rowHistory:clear', id, table)
  },
  history: {
    add: (entry: Omit<HistoryEntry, 'id' | 'ranAt'>) => invoke<HistoryEntry>('history:add', entry),
    list: () => invoke<HistoryEntry[]>('history:list'),
    clear: () => invoke<boolean>('history:clear')
  },
  sizeHistory: {
    record: (connId: string, totalBytes: number, tableCount: number) =>
      invoke<SizeSnapshot>('sizeHistory:record', connId, totalBytes, tableCount),
    list: (connId: string) => invoke<SizeSnapshot[]>('sizeHistory:list', connId)
  },
  snippets: {
    list: () => invoke<Snippet[]>('snippets:list'),
    save: (input: Partial<Snippet> & { name: string; sql: string }) =>
      invoke<Snippet>('snippets:save', input),
    remove: (id: string) => invoke<boolean>('snippets:remove', id)
  },
  snapshots: {
    list: (connId: string) => invoke<Snapshot[]>('snapshots:list', connId),
    create: (connId: string, label: string) =>
      invoke<Snapshot>('snapshots:create', connId, label),
    remove: (connId: string, id: string) => invoke<boolean>('snapshots:remove', connId, id),
    restore: (connId: string, id: string) =>
      invoke<RestoreResult>('snapshots:restore', connId, id)
  },
  notes: {
    list: (connId: string) => invoke<Record<string, string>>('notes:list', connId),
    set: (connId: string, table: string, text: string) =>
      invoke<Record<string, string>>('notes:set', connId, table, text)
  },
  bookmarks: {
    list: (connId: string) => invoke<Bookmark[]>('bookmarks:list', connId),
    save: (connId: string, name: string, sql: string) =>
      invoke<Bookmark>('bookmarks:save', connId, name, sql),
    remove: (connId: string, id: string) => invoke<boolean>('bookmarks:remove', connId, id)
  },
  analytics: {
    listDatasets: (connId: string) =>
      invoke<AnalyticsDataset[]>('analytics:listDatasets', connId),
    saveDataset: (
      input: Partial<AnalyticsDataset> &
        Pick<AnalyticsDataset, 'connectionId' | 'name' | 'source'>
    ) => invoke<AnalyticsDataset>('analytics:saveDataset', input),
    removeDataset: (id: string) => invoke<boolean>('analytics:removeDataset', id),
    listMetrics: (connId: string) => invoke<AnalyticsMetric[]>('analytics:listMetrics', connId),
    saveMetric: (
      input: Partial<AnalyticsMetric> &
        Pick<AnalyticsMetric, 'connectionId' | 'datasetId' | 'name' | 'agg'>
    ) => invoke<AnalyticsMetric>('analytics:saveMetric', input),
    removeMetric: (id: string) => invoke<boolean>('analytics:removeMetric', id),
    listCharts: (connId: string) => invoke<AnalyticsChart[]>('analytics:listCharts', connId),
    saveChart: (
      input: Partial<AnalyticsChart> &
        Pick<AnalyticsChart, 'connectionId' | 'datasetId' | 'name' | 'type' | 'encoding'>
    ) => invoke<AnalyticsChart>('analytics:saveChart', input),
    removeChart: (id: string) => invoke<boolean>('analytics:removeChart', id),
    listDashboards: (connId: string) =>
      invoke<AnalyticsDashboard[]>('analytics:listDashboards', connId),
    saveDashboard: (
      input: Partial<AnalyticsDashboard> &
        Pick<AnalyticsDashboard, 'connectionId' | 'name' | 'widgets'>
    ) => invoke<AnalyticsDashboard>('analytics:saveDashboard', input),
    removeDashboard: (id: string) => invoke<boolean>('analytics:removeDashboard', id),
    listReports: (connId: string) => invoke<ScheduledReport[]>('analytics:listReports', connId),
    saveReport: (
      input: Partial<ScheduledReport> &
        Pick<ScheduledReport, 'connectionId' | 'name' | 'dashboardId' | 'folder' | 'everyMinutes'>
    ) => invoke<ScheduledReport>('analytics:saveReport', input),
    removeReport: (id: string) => invoke<boolean>('analytics:removeReport', id),
    runReport: (id: string) =>
      invoke<{ ok: boolean; path?: string; error?: string }>('analytics:runReport', id)
  },
  ai: {
    hasKey: () => invoke<boolean>('ai:hasKey'),
    setKey: (key: string) => invoke<boolean>('ai:setKey', key),
    clearKey: () => invoke<boolean>('ai:clearKey'),
    generateSql: (req: { driver: string; schema: Record<string, string[]>; prompt: string }) =>
      invoke<{ sql: string; notes: string }>('ai:generateSql', req),
    explainQuery: (req: { driver: string; schema: Record<string, string[]>; sql: string }) =>
      invoke<string>('ai:explainQuery', req),
    adviseReplication: (req: {
      topology: string
      warnSeconds: number
      critSeconds: number
      nodes: {
        name: string
        driver: string
        assignedRole: string
        detectedRole?: string
        isPrimary?: boolean
        lagSeconds?: number | null
        position?: string
        replicas?: { name: string; state?: string; lagSeconds?: number | null }[]
        managedBy?: string | null
        detail?: string[]
        error?: string
        unreachable?: boolean
        notConnected?: boolean
      }[]
    }) => invoke<string>('ai:adviseReplication', req),
    investigate: (req: { connectionId: string; type: InvestigationType; sql?: string; question?: string }) =>
      invoke<InvestigationReport>('ai:investigate', req),
    fixQuery: (req: {
      driver: string
      schema: Record<string, string[]>
      sql: string
      error: string
    }) => invoke<{ sql: string; notes: string }>('ai:fixQuery', req),
    generateSeedData: (req: {
      driver: string
      table: string
      columns: { name: string; type?: string }[]
      count: number
      hint?: string
    }) => invoke<{ rows: Record<string, unknown>[] }>('ai:generateSeedData', req),
    describeSchema: (req: { driver: string; tables: { name: string; columns: string[] }[] }) =>
      invoke<Record<string, string>>('ai:describeSchema', req),
    generateAnalytics: (req: {
      driver: string
      schema: Record<string, string[]>
      prompt: string
      state?: AnalyticsState
    }) => invoke<AnalyticsPlan>('ai:generateAnalytics', req),
    chat: (
      connId: string,
      req: { driver: string; schema: Record<string, string[]>; history: ChatMessage[]; streamId?: string }
    ) => invoke<{ answer: string; steps: ChatStep[] }>('ai:chat', connId, req),
    /** Subscribe to streamed answer deltas; returns an unsubscribe function. */
    onChatDelta: (cb: (id: string, delta: string) => void): (() => void) => {
      const listener = (_e: unknown, p: { id: string; delta: string }): void => cb(p.id, p.delta)
      ipcRenderer.on('ai:chatDelta', listener)
      return () => ipcRenderer.removeListener('ai:chatDelta', listener)
    }
  },
  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    setActiveProvider: (p: AiProvider) => invoke<AppSettings>('settings:setActiveProvider', p),
    setProviderKey: (p: AiProvider, key: string) =>
      invoke<AppSettings>('settings:setProviderKey', p, key),
    clearProviderKey: (p: AiProvider) => invoke<AppSettings>('settings:clearProviderKey', p),
    setProviderConfig: (p: AiProvider, cfg: { model?: string; baseUrl?: string }) =>
      invoke<AppSettings>('settings:setProviderConfig', p, cfg),
    setAppearance: (a: Partial<AppearanceSettings>) =>
      invoke<AppSettings>('settings:setAppearance', a),
    testProvider: (p: AiProvider) => invoke<boolean>('settings:testProvider', p),
    listModels: (p: AiProvider) => invoke<string[]>('settings:listModels', p)
  },
  mcp: {
    get: () => invoke<McpInfo>('mcp:get'),
    setEnabled: (enabled: boolean) => invoke<McpInfo>('mcp:setEnabled', enabled),
    setConfig: (cfg: Partial<Pick<McpSettings, 'port' | 'allowWrites'>>) =>
      invoke<McpInfo>('mcp:setConfig', cfg),
    regenerateToken: () => invoke<McpInfo>('mcp:regenerateToken')
  },
  updates: {
    // main → renderer events (each returns an unsubscribe fn)
    onAvailable: (cb: (version: string) => void): (() => void) => {
      const l = (_e: unknown, p: { version: string }): void => cb(p.version)
      ipcRenderer.on('update:available', l)
      return () => ipcRenderer.removeListener('update:available', l)
    },
    onNone: (cb: () => void): (() => void) => {
      const l = (): void => cb()
      ipcRenderer.on('update:none', l)
      return () => ipcRenderer.removeListener('update:none', l)
    },
    onProgress: (cb: (percent: number) => void): (() => void) => {
      const l = (_e: unknown, p: number): void => cb(p)
      ipcRenderer.on('update:progress', l)
      return () => ipcRenderer.removeListener('update:progress', l)
    },
    onDownloaded: (cb: (version: string) => void): (() => void) => {
      const l = (_e: unknown, p: { version: string }): void => cb(p.version)
      ipcRenderer.on('update:downloaded', l)
      return () => ipcRenderer.removeListener('update:downloaded', l)
    },
    onError: (cb: (message: string) => void): (() => void) => {
      const l = (_e: unknown, p: string): void => cb(p)
      ipcRenderer.on('update:error', l)
      return () => ipcRenderer.removeListener('update:error', l)
    },
    // renderer → main actions
    check: (): void => ipcRenderer.send('update:check'),
    download: (): void => ipcRenderer.send('update:download'),
    install: (): void => ipcRenderer.send('update:install'),
    openReleases: (): void => ipcRenderer.send('update:openReleases')
  },
  setZoom: (factor: number) => webFrame.setZoomFactor(factor),
  getVersion: () => invoke<string>('app:version'),
  pickFile: () => invoke<string | null>('app:pickFile')
}

export type DataDockApi = typeof api

contextBridge.exposeInMainWorld('api', api)
