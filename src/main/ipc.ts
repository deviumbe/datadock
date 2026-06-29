import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import type {
  AlterOp,
  CloneOptions,
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
  TableQueryOptions,
  Topology,
  TruncateOptions
} from '@shared/types'
import type { HistoryEntry, RowVersionInput, Snippet, QueueAction, QueueJobState } from '@shared/types'
import type { MaskConfig } from '@shared/mask'
import * as store from './storage'
import * as db from './db'
import * as io from './io'
import * as history from './history'
import * as sizeHistory from './sizeHistory'
import * as snippets from './snippets'
import * as snapshots from './snapshots'
import { cloneToSqlite } from './clone'
import * as planBaselines from './planBaselines'
import * as rowHistory from './rowHistory'
import * as notes from './notes'
import * as bookmarks from './bookmarks'
import * as analytics from './analytics'
import { runReport } from './scheduler'
import * as ai from './ai'
import * as settings from './settings'
import * as mcp from './mcp'
import { prepareStatement } from './sqlGuard'
import { testProvider } from './aiProviders'
import type { RunSql } from './aiProviders'
import type { AiProvider, AppearanceSettings, McpSettings, QueryResult } from '@shared/types'

type Handler<T> = (...args: any[]) => Promise<T> | T

/** Format a result set as compact JSON for the AI (capped to keep tokens sane). */
function formatRowsForAi(res: QueryResult): { text: string; rowCount: number } {
  const cols = res.columns.map((c) => c.name)
  const cap = 50
  const rows = res.rows
    .slice(0, cap)
    .map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])))
  let text = JSON.stringify(rows)
  text +=
    res.rows.length > cap
      ? `\n(${res.rows.length} rows total; first ${cap} shown)`
      : `\n(${res.rows.length} rows)`
  return { text, rowCount: res.rowCount }
}

/** A read-only query runner for the data-chat, bound to one connection. */
function makeRunSql(connId: string, driver: string): RunSql {
  return async (sql: string) => {
    const trimmed = prepareStatement(driver, sql, true)
    const res = await db.getAdapter(connId).query(trimmed)
    return formatRowsForAi(res)
  }
}

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
  handle('workspace:saveTopology', (topology: Topology) => store.saveTopology(topology))
  handle('workspace:deleteTopology', (id: string) => store.deleteTopology(id))

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
  handle('db:cancelQuery', (id: string) => db.cancelQuery(id))
  handle('db:countRows', (id: string, table: TableInfo, opts: TableQueryOptions) =>
    db.capability(id, 'countRows')(table, opts)
  )
  handle('db:explainPlan', (id: string, sql: string) => db.explainPlan(id, sql))
  handle('db:replicationStatus', (id: string) => db.capability(id, 'replicationStatus')())
  handle('db:txnBegin', (id: string) => db.capability(id, 'beginTransaction')())
  handle('db:txnCommit', (id: string) => db.capability(id, 'commitTransaction')())
  handle('db:txnRollback', (id: string) => db.capability(id, 'rollbackTransaction')())
  handle('db:schema', (id: string) => db.capability(id, 'schema')())
  handle('db:tableSizes', (id: string) => db.capability(id, 'tableSizes')())
  handle('db:erModel', (id: string) => db.capability(id, 'erModel')())
  handle('db:poolStats', (id: string) => db.capability(id, 'poolStats')())
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

  // Redis-specific
  handle('redis:keyValue', (id: string, key: string) =>
    db.capability(id, 'redisKeyValue')(key)
  )
  handle('redis:serverStats', (id: string) => db.capability(id, 'redisServerStats')())
  handle('redis:queues', (id: string) => db.capability(id, 'redisQueues')())
  handle(
    'redis:queueJobs',
    (id: string, queue: string, state: QueueJobState, offset: number, limit: number) =>
      db.capability(id, 'redisQueueJobs')(queue, state, offset, limit)
  )
  handle(
    'redis:queueAction',
    (id: string, action: QueueAction, queue: string, state: QueueJobState, jobId?: string) =>
      db.capability(id, 'redisQueueAction')(action, queue, state, jobId)
  )
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
  handle('db:truncateTables', (id: string, tables: TableInfo[], opts: TruncateOptions) =>
    db.capability(id, 'truncateTables')(tables, opts)
  )

  // Import / export
  handle('io:exportData', (id: string, format: ExportFormat, payload: ExportPayload) =>
    io.exportData(id, format, payload)
  )
  handle('io:exportTable', (id: string, table: TableInfo, format: ExportFormat) =>
    io.exportTable(id, table, format)
  )
  handle(
    'io:exportDatabase',
    (id: string, specs: TableDumpSpec[], format: DumpFormat, maskConfig?: MaskConfig) =>
      io.exportDatabase(id, specs, format, maskConfig)
  )
  handle('io:importSql', (id: string) => io.importSql(id))
  handle('io:importCsv', (id: string, table: TableInfo) => io.importCsv(id, table))
  handle('io:exportConnections', () => io.exportConnections())
  handle('io:importConnections', () => io.importConnections())
  handle('io:saveFile', (name: string, data: string, binary: boolean) =>
    io.saveFile(name, data, binary)
  )
  handle('io:exportPdf', (name: string, html: string, landscape?: boolean) =>
    io.exportHtmlToPdf(name, html, landscape)
  )
  handle('io:pickFolder', () => io.pickFolder())

  // Clone a connection's schema/data into a local SQLite file
  handle('clone:toSqlite', (id: string, opts: CloneOptions) => cloneToSqlite(id, opts))

  // Query-plan baselines (regression alerts)
  handle('planBaselines:get', (id: string, sql: string) => planBaselines.getBaseline(id, sql))
  handle('planBaselines:set', (id: string, sql: string, cost: number, rows?: number) =>
    planBaselines.setBaseline(id, sql, cost, rows)
  )
  handle('planBaselines:remove', (id: string, sql: string) =>
    planBaselines.removeBaseline(id, sql)
  )

  // Time-travel row history (local edit journal)
  handle('rowHistory:record', (id: string, entries: RowVersionInput[]) =>
    rowHistory.record(id, entries)
  )
  handle('rowHistory:list', (id: string, table: string, pk: Record<string, unknown>) =>
    rowHistory.list(id, table, pk)
  )
  handle('rowHistory:clear', (id: string, table?: string) => rowHistory.clear(id, table))

  // Query history
  handle('history:add', (entry: Omit<HistoryEntry, 'id' | 'ranAt'>) => history.addHistory(entry))
  handle('history:list', () => history.listHistory())
  handle('history:clear', () => {
    history.clearHistory()
    return true
  })

  // Storage-size history (growth tracking)
  handle('sizeHistory:record', (connId: string, totalBytes: number, tableCount: number) =>
    sizeHistory.recordSize(connId, totalBytes, tableCount)
  )
  handle('sizeHistory:list', (connId: string) => sizeHistory.listSizes(connId))

  // Saved queries / snippets
  handle('snippets:list', () => snippets.listSnippets())
  handle('snippets:save', (input: Partial<Snippet> & { name: string; sql: string }) =>
    snippets.saveSnippet(input)
  )
  handle('snippets:remove', (id: string) => {
    snippets.removeSnippet(id)
    return true
  })

  // Database snapshots (restore points)
  handle('snapshots:list', (connId: string) => snapshots.listSnapshots(connId))
  handle('snapshots:create', (connId: string, label: string) =>
    snapshots.createSnapshot(connId, label)
  )
  handle('snapshots:remove', (connId: string, id: string) =>
    snapshots.deleteSnapshot(connId, id)
  )
  handle('snapshots:restore', (connId: string, id: string) =>
    snapshots.restoreSnapshot(connId, id)
  )

  // Per-table notes (local)
  handle('notes:list', (connId: string) => notes.listNotes(connId))
  handle('notes:set', (connId: string, table: string, text: string) =>
    notes.setNote(connId, table, text)
  )

  // Per-connection query bookmarks (local)
  handle('bookmarks:list', (connId: string) => bookmarks.listBookmarks(connId))
  handle('bookmarks:save', (connId: string, name: string, sql: string) =>
    bookmarks.saveBookmark(connId, name, sql)
  )
  handle('bookmarks:remove', (connId: string, id: string) =>
    bookmarks.removeBookmark(connId, id)
  )

  // Analytics module: datasets + saved charts (persisted per connection)
  handle('analytics:listDatasets', (connId: string) => analytics.listDatasets(connId))
  handle(
    'analytics:saveDataset',
    (input: Parameters<typeof analytics.saveDataset>[0]) => analytics.saveDataset(input)
  )
  handle('analytics:removeDataset', (id: string) => {
    analytics.removeDataset(id)
    return true
  })
  handle('analytics:listMetrics', (connId: string) => analytics.listMetrics(connId))
  handle('analytics:saveMetric', (input: Parameters<typeof analytics.saveMetric>[0]) =>
    analytics.saveMetric(input)
  )
  handle('analytics:removeMetric', (id: string) => {
    analytics.removeMetric(id)
    return true
  })
  handle('analytics:listCharts', (connId: string) => analytics.listCharts(connId))
  handle('analytics:saveChart', (input: Parameters<typeof analytics.saveChart>[0]) =>
    analytics.saveChart(input)
  )
  handle('analytics:removeChart', (id: string) => {
    analytics.removeChart(id)
    return true
  })
  handle('analytics:listDashboards', (connId: string) => analytics.listDashboards(connId))
  handle('analytics:saveDashboard', (input: Parameters<typeof analytics.saveDashboard>[0]) =>
    analytics.saveDashboard(input)
  )
  handle('analytics:removeDashboard', (id: string) => {
    analytics.removeDashboard(id)
    return true
  })
  handle('analytics:listReports', (connId: string) => analytics.listReports(connId))
  handle('analytics:saveReport', (input: Parameters<typeof analytics.saveReport>[0]) =>
    analytics.saveReport(input)
  )
  handle('analytics:removeReport', (id: string) => {
    analytics.removeReport(id)
    return true
  })
  handle('analytics:runReport', (id: string) => runReport(id))

  // AI SQL assistant (key held + used only in main; never sent to renderer)
  handle('ai:hasKey', () => ai.hasAiKey())
  handle('ai:setKey', (key: string) => ai.setAiKey(key))
  handle('ai:clearKey', () => ai.clearAiKey())
  handle('ai:generateSql', (req: ai.AiSqlRequest) => ai.generateSql(req))
  handle('ai:explainQuery', (req: ai.AiExplainRequest) => ai.explainQuery(req))
  handle('ai:fixQuery', (req: ai.AiFixRequest) => ai.fixQuery(req))
  handle('ai:generateSeedData', (req: ai.AiSeedRequest) => ai.generateSeedData(req))
  handle('ai:describeSchema', (req: ai.AiDescribeRequest) => ai.describeSchema(req))
  handle('ai:generateAnalytics', (req: ai.AiAnalyticsRequest) => ai.generateAnalytics(req))
  handle('ai:chat', (connId: string, req: ai.AiChatRequest) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents
    const onDelta =
      req.streamId && wc
        ? (delta: string) => wc.send('ai:chatDelta', { id: req.streamId, delta })
        : undefined
    return ai.chat(req, makeRunSql(connId, req.driver), onDelta)
  })

  // Settings (AI providers + appearance; keys encrypted, never returned raw)
  handle('settings:get', () => settings.getSettings())
  handle('settings:setActiveProvider', (p: AiProvider) => settings.setActiveProvider(p))
  handle('settings:setProviderKey', (p: AiProvider, key: string) => settings.setProviderKey(p, key))
  handle('settings:clearProviderKey', (p: AiProvider) => settings.clearProviderKey(p))
  handle('settings:setProviderConfig', (p: AiProvider, cfg: { model?: string; baseUrl?: string }) =>
    settings.setProviderConfig(p, cfg)
  )
  handle('settings:setAppearance', (a: Partial<AppearanceSettings>) => settings.setAppearance(a))
  handle('settings:testProvider', async (p: AiProvider) => {
    await testProvider(p)
    return true
  })

  // MCP server (local AI-agent access to the user's databases; off by default)
  handle('mcp:get', () => mcp.getMcpInfo())
  handle('mcp:setEnabled', (enabled: boolean) => mcp.setEnabled(enabled))
  handle('mcp:setConfig', (cfg: Partial<Pick<McpSettings, 'port' | 'allowWrites'>>) =>
    mcp.setConfig(cfg)
  )
  handle('mcp:regenerateToken', () => mcp.regenerateToken())

  handle('app:version', () => app.getVersion())

  // File picker (e.g. SSH private key)
  handle('app:pickFile', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'] })
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })
}
