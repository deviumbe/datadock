import { defineStore } from 'pinia'
import { ref, markRaw, computed, watch } from 'vue'
import { useWorkspace } from './workspace'
import type {
  AlterOp,
  ChatMessage,
  ErModel,
  FilterSpec,
  HistoryEntry,
  QueryResult,
  RowChangeSet,
  RowEdit,
  Snippet,
  SortSpec,
  TableInfo,
  TableStructure
} from '@shared/types'
import { useSettings } from './settings'

export type TabKind =
  | 'query'
  | 'table'
  | 'databases'
  | 'users'
  | 'processes'
  | 'history'
  | 'snippets'
  | 'diagram'
  | 'schemaDiff'
  | 'dataDiff'
  | 'chat'
  | 'explorer'
  | 'related'
  | 'analytics'
  | 'performance'
  | 'docs'
  | 'search'
  | 'envDiff'
  | 'redisQueues'
  | 'visualQuery'

/** One stop in the record explorer: a single row identified by column = value. */
export interface ExplorerFocus {
  table: string
  column: string
  value: unknown
  /** Optional human label for the breadcrumb (defaults to `table #value`). */
  label?: string
}

export interface Tab {
  id: string
  connectionId: string
  kind: TabKind
  title: string
  query: string
  table?: TableInfo
  result: QueryResult | null
  error: string | null
  running: boolean
  databases?: string[]
  entries?: HistoryEntry[]
  snippets?: Snippet[]
  erModel?: ErModel | null
  chatMessages?: ChatMessage[]
  chatBusy?: boolean

  // record-explorer state: a navigation trail + the current position in it
  explorerStack?: ExplorerFocus[]
  explorerIndex?: number

  // related-records overview: the root record whose relationships we aggregate
  relatedFocus?: ExplorerFocus

  // table-tab state
  primaryKeys: string[]
  pageSize: number
  offset: number
  sort?: SortSpec
  filters: FilterSpec[]
  edits: Record<number, Record<string, unknown>>
  inserts: Record<string, unknown>[]
  deletes: number[]
  selectedRow: number | null
  /** Row indices ticked for multi-row (bulk) operations. */
  selection: number[]
  viewMode: 'data' | 'structure'
  structure: TableStructure | null
  /** Cached total row count for the current filters (null = not yet known). */
  totalRows: number | null
  /** Filter signature the cached count corresponds to. */
  totalRowsKey: string
  history: DraftSnapshot[]
  future: DraftSnapshot[]
}

/** Snapshot of a table tab's pending (uncommitted) edits, for undo/redo. */
interface DraftSnapshot {
  edits: Record<number, Record<string, unknown>>
  inserts: Record<string, unknown>[]
  deletes: number[]
}

// Best-effort detection of write statements, for read-only mode.
const MUTATING_SQL =
  /(^|;)\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|merge|call)\b/i

// Redis commands that mutate data — blocked on a read-only connection.
const REDIS_WRITE =
  /^\s*(set|setex|setnx|psetex|getset|append|incr|incrby|incrbyfloat|decr|decrby|mset|msetnx|del|unlink|expire|pexpire|expireat|persist|rename|renamenx|move|copy|restore|lpush|rpush|lpushx|rpushx|lpop|rpop|lset|linsert|lrem|ltrim|rpoplpush|lmove|blpop|brpop|sadd|srem|spop|smove|sinterstore|sunionstore|sdiffstore|zadd|zrem|zincrby|zpopmin|zpopmax|zremrangebyrank|zremrangebyscore|zremrangebylex|hset|hsetnx|hmset|hdel|hincrby|hincrbyfloat|xadd|xdel|xtrim|xsetid|xgroup|xack|xclaim|pfadd|pfmerge|setbit|setrange|geoadd|flushdb|flushall|swapdb)\b/i

/** Returns a warning if a statement is destructive (UPDATE/DELETE w/o WHERE, TRUNCATE, DROP). */
function dangerousStatement(sql: string): string | null {
  for (const raw of sql.split(';')) {
    const s = raw.replace(/--[^\n]*/g, '').trim()
    if (!s) continue
    if (/^update\b/i.test(s) && !/\bwhere\b/i.test(s)) {
      return '⚠ This UPDATE has no WHERE clause — it will modify EVERY row.'
    }
    if (/^delete\s+from\b/i.test(s) && !/\bwhere\b/i.test(s)) {
      return '⚠ This DELETE has no WHERE clause — it will remove EVERY row.'
    }
    if (/^truncate\b/i.test(s)) return '⚠ TRUNCATE empties the entire table.'
    if (/^drop\s+(table|database|schema)\b/i.test(s)) return `⚠ ${s.slice(0, 60)} — this drops a database object.`
  }
  return null
}

let counter = 0
const uid = (): string => `tab-${Date.now()}-${counter++}`
const plainTable = (t: TableInfo): TableInfo => ({ schema: t.schema, name: t.name, type: t.type })

export const useTabs = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([])
  const activeByConn = ref<Record<string, string>>({})
  const savedSnippets = ref<Snippet[]>([])

  async function loadSnippets(): Promise<void> {
    try {
      savedSnippets.value = await window.api.snippets.list()
    } catch {
      savedSnippets.value = []
    }
  }
  void loadSnippets()

  /** The saved snippet whose SQL matches `sql` (trimmed), if any. */
  const matchingSnippet = (sql: string): Snippet | undefined => {
    const t = sql.trim()
    return t ? savedSnippets.value.find((s) => s.sql.trim() === t) : undefined
  }

  const forConnection = (connId: string): Tab[] =>
    tabs.value.filter((t) => t.connectionId === connId)
  const activeTab = (connId: string): Tab | null =>
    tabs.value.find((t) => t.id === activeByConn.value[connId]) ?? null

  function setActive(connId: string, tabId: string): void {
    activeByConn.value[connId] = tabId
  }

  function base(connectionId: string, kind: TabKind, title: string): Tab {
    return {
      id: uid(),
      connectionId,
      kind,
      title,
      query: '',
      result: null,
      error: null,
      running: false,
      primaryKeys: [],
      pageSize: useSettings().pageSize || 200,
      offset: 0,
      filters: [],
      edits: {},
      inserts: [],
      deletes: [],
      selectedRow: null,
      selection: [],
      viewMode: 'data',
      structure: null,
      totalRows: null,
      totalRowsKey: '',
      history: [],
      future: []
    }
  }

  // ---- draft history (undo/redo) --------------------------------------------
  const snapshot = (tab: Tab): DraftSnapshot =>
    JSON.parse(JSON.stringify({ edits: tab.edits, inserts: tab.inserts, deletes: tab.deletes }))

  /** Capture the current draft before a mutating change, so it can be undone. */
  function record(tab: Tab): void {
    tab.history.push(snapshot(tab))
    if (tab.history.length > 100) tab.history.shift()
    tab.future = []
  }

  function restore(tab: Tab, s: DraftSnapshot): void {
    tab.edits = JSON.parse(JSON.stringify(s.edits))
    tab.inserts = JSON.parse(JSON.stringify(s.inserts))
    tab.deletes = JSON.parse(JSON.stringify(s.deletes))
  }

  function undo(tab: Tab): void {
    if (!tab.history.length) return
    tab.future.push(snapshot(tab))
    restore(tab, tab.history.pop()!)
  }
  function redo(tab: Tab): void {
    if (!tab.future.length) return
    tab.history.push(snapshot(tab))
    restore(tab, tab.future.pop()!)
  }
  const canUndo = (tab: Tab): boolean => tab.history.length > 0
  const canRedo = (tab: Tab): boolean => tab.future.length > 0

  function push(tab: Tab): Tab {
    tabs.value.push(tab)
    // Return the reactive proxy stored in the array — not the raw `tab` — so
    // async mutations (initTable/run) trigger re-renders instead of silently
    // updating a detached object that the UI never sees.
    const stored = tabs.value[tabs.value.length - 1]
    setActive(stored.connectionId, stored.id)
    return stored
  }

  function openQuery(connId: string): Tab {
    return push(base(connId, 'query', 'Query'))
  }

  function openTable(connId: string, table: TableInfo): Tab {
    const t = plainTable(table)
    const existing = tabs.value.find(
      (x) => x.connectionId === connId && x.kind === 'table' && x.table?.name === t.name && x.table?.schema === t.schema
    )
    if (existing) {
      setActive(connId, existing.id)
      return existing
    }
    const tab = push({ ...base(connId, 'table', t.name), table: t })
    void initTable(tab)
    return tab
  }

  /**
   * Open (or reuse) a table tab pre-filtered to a single column = value — used
   * by the grid's inline foreign-key navigation to jump to the referenced row.
   */
  function openTableFiltered(
    connId: string,
    table: TableInfo,
    column: string,
    value: unknown
  ): Tab {
    const t = plainTable(table)
    const filters = [{ column, op: '=' as const, value: value == null ? '' : String(value) }]
    const existing = tabs.value.find(
      (x) =>
        x.connectionId === connId &&
        x.kind === 'table' &&
        x.table?.name === t.name &&
        x.table?.schema === t.schema
    )
    if (existing) {
      existing.filters = filters
      existing.offset = 0
      setActive(connId, existing.id)
      void reloadTable(existing)
      return existing
    }
    const tab = push({ ...base(connId, 'table', t.name), table: t, filters })
    void initTable(tab)
    return tab
  }

  function openPerformance(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'performance')
    const tab = existing ?? push(base(connId, 'performance', 'Performance'))
    setActive(connId, tab.id)
    return tab
  }

  function openDocs(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'docs')
    const tab = existing ?? push(base(connId, 'docs', 'Documentation'))
    setActive(connId, tab.id)
    return tab
  }

  function openSearch(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'search')
    const tab = existing ?? push(base(connId, 'search', 'Search'))
    setActive(connId, tab.id)
    return tab
  }

  function openAnalytics(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'analytics')
    const tab = existing ?? push(base(connId, 'analytics', 'Analytics'))
    setActive(connId, tab.id)
    return tab
  }

  function openEnvDiff(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'envDiff')
    const tab = existing ?? push(base(connId, 'envDiff', 'Environment Diff'))
    setActive(connId, tab.id)
    return tab
  }

  function openRedisQueues(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'redisQueues')
    const tab = existing ?? push(base(connId, 'redisQueues', 'Redis Queues'))
    setActive(connId, tab.id)
    return tab
  }

  function openServer(connId: string, kind: 'databases' | 'users' | 'processes'): Tab {
    const titles = { databases: 'Databases', users: 'Users', processes: 'Processes' }
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === kind)
    const tab = existing ?? push(base(connId, kind, titles[kind]))
    if (existing) setActive(connId, existing.id)
    void run(tab)
    return tab
  }

  function openHistory(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'history')
    const tab = existing ?? push(base(connId, 'history', 'Query History'))
    if (existing) setActive(connId, existing.id)
    void run(tab)
    return tab
  }

  function openSnippets(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'snippets')
    const tab = existing ?? push(base(connId, 'snippets', 'Saved Queries'))
    if (existing) setActive(connId, existing.id)
    void run(tab)
    return tab
  }

  function openDiagram(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'diagram')
    const tab = existing ?? push(base(connId, 'diagram', 'ER Diagram'))
    if (existing) setActive(connId, existing.id)
    void run(tab)
    return tab
  }

  function openVisualQuery(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'visualQuery')
    if (existing) {
      setActive(connId, existing.id)
      return existing
    }
    const tab = push(base(connId, 'visualQuery', 'Query Builder'))
    return tab
  }

  function openChat(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'chat')
    if (existing) {
      setActive(connId, existing.id)
      return existing
    }
    const tab = push(base(connId, 'chat', 'Chat with data'))
    tab.chatMessages = []
    return tab
  }

  /** Send a user message to the data-chat and append the assistant's reply. */
  async function sendChat(tab: Tab, text: string): Promise<void> {
    const msg = text.trim()
    if (!msg || tab.chatBusy) return
    const conn = useWorkspace().findConnection(tab.connectionId)
    if (!conn) return
    tab.chatMessages = [...(tab.chatMessages ?? []), { role: 'user', content: msg }]
    tab.chatBusy = true
    tab.error = null
    try {
      const history = (tab.chatMessages ?? []).map((m) => ({ role: m.role, content: m.content }))
      // Deep-clone to strip Vue reactivity — reactive Proxies can't be
      // structured-cloned across the IPC boundary ("object could not be cloned").
      const schema = JSON.parse(
        JSON.stringify(useWorkspace().schemas[tab.connectionId] ?? {})
      ) as Record<string, string[]>
      const res = await window.api.ai.chat(tab.connectionId, {
        driver: conn.driver,
        schema,
        history
      })
      tab.chatMessages = [
        ...(tab.chatMessages ?? []),
        { role: 'assistant', content: res.answer, steps: res.steps }
      ]
    } catch (e) {
      tab.chatMessages = [
        ...(tab.chatMessages ?? []),
        { role: 'assistant', content: `⚠ ${e instanceof Error ? e.message : String(e)}` }
      ]
    } finally {
      tab.chatBusy = false
    }
  }

  function clearChat(tab: Tab): void {
    tab.chatMessages = []
  }

  // Standalone chat sessions for the slide-out chat dock, keyed by connection.
  // These reuse the Tab shape (and sendChat/clearChat) but live outside the
  // tab strip, so the assistant can be used without a query tab open.
  const dockChats = ref<Record<string, Tab>>({})
  function dockChatFor(connId: string): Tab {
    let session = dockChats.value[connId]
    if (!session) {
      session = base(connId, 'chat', 'Chat with data')
      session.chatMessages = []
      dockChats.value[connId] = session
    }
    return session
  }

  // ---- record explorer (click-through relationships) -----------------------
  function explorerTitle(f: ExplorerFocus): string {
    return f.label ?? `${f.table} #${String(f.value)}`
  }

  /** Open (or reuse) the explorer tab, starting a fresh trail at `focus`. */
  function openExplorer(connId: string, focus: ExplorerFocus): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'explorer')
    const tab = existing ?? push(base(connId, 'explorer', 'Explorer'))
    tab.explorerStack = [focus]
    tab.explorerIndex = 0
    tab.title = explorerTitle(focus)
    setActive(connId, tab.id)
    return tab
  }

  /** Open (or reuse) the related-records overview for a single root record. */
  function openRelated(connId: string, focus: ExplorerFocus): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'related')
    const tab = existing ?? push(base(connId, 'related', 'Related'))
    tab.relatedFocus = focus
    tab.title = `Related · ${explorerTitle(focus)}`
    setActive(connId, tab.id)
    return tab
  }

  /** Drill into a related record — truncates any forward history, then pushes. */
  function navigateExplorer(tab: Tab, focus: ExplorerFocus): void {
    const idx = tab.explorerIndex ?? 0
    const stack = (tab.explorerStack ?? []).slice(0, idx + 1)
    stack.push(focus)
    tab.explorerStack = stack
    tab.explorerIndex = stack.length - 1
    tab.title = explorerTitle(focus)
  }

  /** Jump to an existing breadcrumb position. */
  function explorerGoTo(tab: Tab, index: number): void {
    const stack = tab.explorerStack ?? []
    if (index < 0 || index >= stack.length) return
    tab.explorerIndex = index
    tab.title = explorerTitle(stack[index])
  }

  function openSchemaDiff(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'schemaDiff')
    const tab = existing ?? push(base(connId, 'schemaDiff', 'Schema Diff'))
    if (existing) setActive(connId, existing.id)
    return tab
  }

  function openDataDiff(connId: string): Tab {
    const existing = tabs.value.find((x) => x.connectionId === connId && x.kind === 'dataDiff')
    const tab = existing ?? push(base(connId, 'dataDiff', 'Data Diff'))
    if (existing) setActive(connId, existing.id)
    return tab
  }

  function closeTab(id: string): void {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx < 0) return
    const { connectionId } = tabs.value[idx]
    const wasActive = activeByConn.value[connectionId] === id
    tabs.value.splice(idx, 1)
    if (wasActive) {
      const siblings = forConnection(connectionId)
      activeByConn.value[connectionId] = siblings.length ? siblings[siblings.length - 1].id : ''
    }
  }

  function closeForConnection(connId: string): void {
    tabs.value = tabs.value.filter((t) => t.connectionId !== connId)
    delete activeByConn.value[connId]
  }

  /** First load of a table tab: detect primary keys, then fetch the first page. */
  async function initTable(tab: Tab): Promise<void> {
    try {
      tab.primaryKeys = await window.api.db.primaryKeys(tab.connectionId, plainTable(tab.table!))
    } catch {
      tab.primaryKeys = [] // no PK / unsupported -> read-only
    }
    await reloadTable(tab)
  }

  /**
   * Fetch the true total row count for the current filters (background, best-effort).
   * Skips the query when paging/sorting — the count only depends on the filters —
   * and silently does nothing for engines without a countRows capability.
   */
  async function countRowsFor(tab: Tab): Promise<void> {
    if (!tab.table) return
    const activeFilters = tab.filters.filter((f) => f.column)
    const key = JSON.stringify(activeFilters)
    if (tab.totalRowsKey === key && tab.totalRows !== null) return
    tab.totalRows = null
    tab.totalRowsKey = key
    try {
      const n = await window.api.db.countRows(tab.connectionId, plainTable(tab.table), {
        limit: 0,
        offset: 0,
        filters: activeFilters.map((f) => ({ column: f.column, op: f.op, value: f.value }))
      })
      // Only apply if the filters haven't changed since we started counting.
      if (tab.totalRowsKey === key) tab.totalRows = n
    } catch {
      /* engine has no count capability, or the count failed — leave it unknown */
    }
  }

  async function reloadTable(tab: Tab): Promise<void> {
    if (!tab.table) return
    tab.running = true
    tab.error = null
    try {
      // Send plain copies — `tab.sort`/`tab.filters` are reactive Proxies, which
      // can't be structured-cloned across the IPC boundary.
      const result = await window.api.db.tableData(tab.connectionId, plainTable(tab.table), {
        limit: tab.pageSize,
        offset: tab.offset,
        sort: tab.sort ? { column: tab.sort.column, dir: tab.sort.dir } : undefined,
        filters: tab.filters
          .filter((f) => f.column)
          .map((f) => ({ column: f.column, op: f.op, value: f.value }))
      })
      tab.result = markRaw(result)
      tab.edits = {}
      tab.inserts = []
      tab.deletes = []
      tab.history = []
      tab.future = []
      tab.selectedRow = null
      tab.selection = []
      void countRowsFor(tab) // background — total only changes when filters change
    } catch (e) {
      tab.error = e instanceof Error ? e.message : String(e)
    } finally {
      tab.running = false
    }
  }

  /** Ask the engine to cancel this tab's in-flight query (pg/mysql/mssql). */
  function cancel(tab: Tab): void {
    void window.api.db.cancelQuery(tab.connectionId)
  }

  async function run(tab: Tab, sqlOverride?: string): Promise<void> {
    if (tab.kind === 'table') return reloadTable(tab)
    if (tab.kind === 'query' && !tab.query.trim()) return
    tab.running = true
    tab.error = null
    try {
      if (tab.kind === 'query') {
        const sql = sqlOverride ?? tab.query
        const driver = useWorkspace().findConnection(tab.connectionId)?.driver
        const mutates = driver === 'redis' ? REDIS_WRITE.test(sql) : MUTATING_SQL.test(sql)
        if (isReadOnly(tab.connectionId) && mutates) {
          tab.error = 'Read-only mode: this statement modifies data and was blocked.'
          return
        }
        const danger = dangerousStatement(sql)
        if (danger && !window.confirm(`${danger}\n\nRun it anyway?`)) return
        try {
          const res = await window.api.db.query(tab.connectionId, sql)
          tab.result = markRaw(res)
          void window.api.history.add({
            connectionId: tab.connectionId,
            sql,
            durationMs: res.durationMs,
            rowCount: res.rowCount
          })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          tab.error = msg
          void window.api.history.add({ connectionId: tab.connectionId, sql, error: msg })
        }
      } else if (tab.kind === 'users') {
        tab.result = markRaw(await window.api.db.listUsers(tab.connectionId))
      } else if (tab.kind === 'processes') {
        tab.result = markRaw(await window.api.db.listProcesses(tab.connectionId))
      } else if (tab.kind === 'databases') {
        tab.databases = await window.api.db.listDatabases(tab.connectionId)
      } else if (tab.kind === 'history') {
        tab.entries = await window.api.history.list()
      } else if (tab.kind === 'snippets') {
        tab.snippets = await window.api.snippets.list()
      } else if (tab.kind === 'diagram') {
        tab.erModel = await window.api.db.erModel(tab.connectionId)
      }
    } catch (e) {
      tab.error = e instanceof Error ? e.message : String(e)
    } finally {
      tab.running = false
    }
  }

  /** Open a new query tab seeded with SQL (e.g. from history or a snippet). */
  function openQueryWith(connId: string, sql: string, title?: string): Tab {
    const tab = push(base(connId, 'query', title || 'Query'))
    tab.query = sql
    return tab
  }

  /** Run the query through the engine's EXPLAIN and show the plan in the grid. */
  async function explain(tab: Tab): Promise<void> {
    if (tab.kind !== 'query' || !tab.query.trim()) return
    const driver = useWorkspace().findConnection(tab.connectionId)?.driver
    const prefix = driver === 'sqlite' ? 'explain query plan ' : 'explain '
    tab.running = true
    tab.error = null
    try {
      tab.result = markRaw(await window.api.db.query(tab.connectionId, prefix + tab.query))
    } catch (e) {
      tab.error = e instanceof Error ? e.message : String(e)
    } finally {
      tab.running = false
    }
  }

  async function clearHistory(tab: Tab): Promise<void> {
    await window.api.history.clear()
    tab.entries = []
  }

  /** Refresh the global snippet list + any open Saved Queries tabs. */
  async function refreshSnippetTabs(): Promise<void> {
    const list = await window.api.snippets.list()
    savedSnippets.value = list
    for (const t of tabs.value) if (t.kind === 'snippets') t.snippets = list
  }
  async function saveSnippet(name: string, sql: string): Promise<void> {
    await window.api.snippets.save({ name, sql })
    await refreshSnippetTabs()
  }
  async function deleteSnippet(_tab: Tab, id: string): Promise<void> {
    await window.api.snippets.remove(id)
    await refreshSnippetTabs()
  }

  // ---- structure ------------------------------------------------------------
  function setViewMode(tab: Tab, mode: 'data' | 'structure'): void {
    tab.viewMode = mode
    tab.error = null // don't carry a stale error between views
    if (mode === 'structure' && !tab.structure) void loadStructure(tab)
  }

  async function loadStructure(tab: Tab): Promise<void> {
    if (!tab.table) return
    tab.running = true
    tab.error = null
    try {
      tab.structure = await window.api.db.tableStructure(tab.connectionId, plainTable(tab.table))
    } catch (e) {
      tab.structure = null
      tab.error = e instanceof Error ? e.message : String(e)
    } finally {
      tab.running = false
    }
  }

  async function applyAlter(tab: Tab, op: AlterOp): Promise<void> {
    if (!tab.table) return
    tab.running = true
    tab.error = null
    try {
      await window.api.db.alterTable(tab.connectionId, plainTable(tab.table), op)
      await loadStructure(tab)
      tab.primaryKeys = await window.api.db
        .primaryKeys(tab.connectionId, plainTable(tab.table))
        .catch(() => [])
      await reloadTable(tab)
    } catch (e) {
      tab.error = e instanceof Error ? e.message : String(e)
      tab.running = false
    }
  }

  // ---- pagination / sort / filter -------------------------------------------
  function nextPage(tab: Tab): void {
    if (tab.result && tab.result.rows.length < tab.pageSize) return
    tab.offset += tab.pageSize
    void reloadTable(tab)
  }
  function prevPage(tab: Tab): void {
    tab.offset = Math.max(0, tab.offset - tab.pageSize)
    void reloadTable(tab)
  }
  function setPageSize(tab: Tab, size: number): void {
    tab.pageSize = size
    tab.offset = 0
    void reloadTable(tab)
  }
  function toggleSort(tab: Tab, column: string): void {
    if (tab.sort?.column !== column) tab.sort = { column, dir: 'asc' }
    else if (tab.sort.dir === 'asc') tab.sort = { column, dir: 'desc' }
    else tab.sort = undefined
    tab.offset = 0
    void reloadTable(tab)
  }
  function setFilters(tab: Tab, filters: FilterSpec[]): void {
    tab.filters = filters
    tab.offset = 0
    void reloadTable(tab)
  }

  // ---- editing --------------------------------------------------------------
  const dirtyCount = (tab: Tab): number =>
    Object.values(tab.edits).reduce((n, cols) => n + Object.keys(cols).length, 0) +
    tab.inserts.length +
    tab.deletes.length

  const isReadOnly = (connId: string): boolean => useWorkspace().isReadOnly(connId)

  const editsAllowed = (tab: Tab): boolean =>
    tab.kind === 'table' && tab.primaryKeys.length > 0 && !isReadOnly(tab.connectionId)

  function editCell(tab: Tab, rowIndex: number, column: string, value: unknown): void {
    if (!editsAllowed(tab)) return
    record(tab)
    const original = tab.result?.rows[rowIndex]
    const colIdx = tab.result?.columns.findIndex((c) => c.name === column) ?? -1
    const current = tab.edits[rowIndex] ?? {}
    if (colIdx >= 0 && String(original?.[colIdx] ?? '') === String(value ?? '')) {
      delete current[column] // back to original -> not dirty
    } else {
      current[column] = value
    }
    if (Object.keys(current).length) tab.edits = { ...tab.edits, [rowIndex]: current }
    else {
      const copy = { ...tab.edits }
      delete copy[rowIndex]
      tab.edits = copy
    }
  }

  /** Explicitly set a data cell to SQL NULL (distinct from an empty string). */
  function setCellNull(tab: Tab, rowIndex: number, column: string): void {
    if (!editsAllowed(tab) || !tab.result) return
    record(tab)
    const colIdx = tab.result.columns.findIndex((c) => c.name === column)
    const original = colIdx >= 0 ? tab.result.rows[rowIndex]?.[colIdx] : undefined
    const current = { ...(tab.edits[rowIndex] ?? {}) }
    if (original === null || original === undefined) {
      delete current[column] // already NULL -> not dirty
    } else {
      current[column] = null
    }
    if (Object.keys(current).length) tab.edits = { ...tab.edits, [rowIndex]: current }
    else {
      const copy = { ...tab.edits }
      delete copy[rowIndex]
      tab.edits = copy
    }
  }

  /** Stage the same value for one column across many rows, as a single undo step. */
  function bulkEdit(tab: Tab, rowIndices: number[], column: string, value: unknown): void {
    if (!editsAllowed(tab) || !tab.result || rowIndices.length === 0) return
    const colIdx = tab.result.columns.findIndex((c) => c.name === column)
    if (colIdx < 0) return
    record(tab)
    const edits = { ...tab.edits }
    for (const rowIndex of rowIndices) {
      const original = tab.result.rows[rowIndex]
      if (!original) continue
      const current = { ...(edits[rowIndex] ?? {}) }
      if (String(original[colIdx] ?? '') === String(value ?? '')) {
        delete current[column] // back to original -> not dirty
      } else {
        current[column] = value
      }
      if (Object.keys(current).length) edits[rowIndex] = current
      else delete edits[rowIndex]
    }
    tab.edits = edits
  }

  // ---- multi-row selection (for bulk operations) ----------------------------
  function toggleRowSelection(tab: Tab, rowIndex: number): void {
    tab.selection = tab.selection.includes(rowIndex)
      ? tab.selection.filter((r) => r !== rowIndex)
      : [...tab.selection, rowIndex]
  }
  function toggleSelectAll(tab: Tab): void {
    const total = tab.result?.rows.length ?? 0
    tab.selection = tab.selection.length === total ? [] : Array.from({ length: total }, (_, i) => i)
  }
  function clearSelection(tab: Tab): void {
    tab.selection = []
  }

  function discardEdits(tab: Tab): void {
    record(tab)
    tab.edits = {}
    tab.inserts = []
    tab.deletes = []
  }

  /** Append a blank new row to fill in. */
  function addInsertRow(tab: Tab): void {
    if (!editsAllowed(tab)) return
    record(tab)
    tab.inserts = [...tab.inserts, {}]
  }
  function editInsert(tab: Tab, index: number, column: string, value: unknown): void {
    record(tab)
    const row = { ...tab.inserts[index] }
    if (value === '' || value === null || value === undefined) delete row[column]
    else row[column] = value
    const copy = [...tab.inserts]
    copy[index] = row
    tab.inserts = copy
  }
  function removeInsert(tab: Tab, index: number): void {
    record(tab)
    tab.inserts = tab.inserts.filter((_, i) => i !== index)
  }

  /** Append a new insert row pre-filled from an existing row (primary keys
   *  dropped so they auto-generate / don't collide). */
  function duplicateRow(tab: Tab, rowIndex: number): void {
    if (!editsAllowed(tab) || tab.kind !== 'table' || !tab.result) return
    const row = tab.result.rows[rowIndex] as unknown[]
    if (!row) return
    record(tab)
    const insert: Record<string, unknown> = {}
    tab.result.columns.forEach((c, i) => {
      if (tab.primaryKeys.includes(c.name)) return
      const v = row[i]
      if (v !== null && v !== undefined) insert[c.name] = v
    })
    tab.inserts = [...tab.inserts, insert]
  }

  /** Mark / unmark an existing data row for deletion. */
  function toggleDelete(tab: Tab, rowIndex: number): void {
    if (!editsAllowed(tab)) return
    record(tab)
    tab.deletes = tab.deletes.includes(rowIndex)
      ? tab.deletes.filter((r) => r !== rowIndex)
      : [...tab.deletes, rowIndex]
  }
  const isDeleted = (tab: Tab, rowIndex: number): boolean => tab.deletes.includes(rowIndex)

  /** Mark every checkbox-selected row for deletion at once, then clear the selection. */
  function deleteSelectedRows(tab: Tab): void {
    if (!editsAllowed(tab) || !tab.selection.length) return
    record(tab)
    const marked = new Set([...tab.deletes, ...tab.selection])
    tab.deletes = [...marked]
    tab.selection = []
  }

  async function commit(tab: Tab): Promise<void> {
    if (!tab.table || !tab.result || dirtyCount(tab) === 0) return
    const colIndex: Record<string, number> = {}
    tab.result.columns.forEach((c, i) => (colIndex[c.name] = i))

    // Build plain (non-reactive) payloads for IPC.
    const updates: RowEdit[] = Object.entries(tab.edits)
      .filter(([rowIdx]) => !tab.deletes.includes(Number(rowIdx))) // a deleted row needs no update
      .map(([rowIdx, changes]) => {
        const row = tab.result!.rows[Number(rowIdx)]
        const pk: Record<string, unknown> = {}
        for (const k of tab.primaryKeys) pk[k] = row[colIndex[k]]
        return { pk, changes: { ...changes } }
      })

    const deletes = tab.deletes.map((rowIdx) => {
      const row = tab.result!.rows[rowIdx]
      const pk: Record<string, unknown> = {}
      for (const k of tab.primaryKeys) pk[k] = row[colIndex[k]]
      return pk
    })

    const inserts = tab.inserts
      .map((r) => {
        const obj: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r)) {
          if (v !== '' && v !== null && v !== undefined) obj[k] = v
        }
        return obj
      })
      .filter((r) => Object.keys(r).length > 0)

    const changeset: RowChangeSet = { updates, inserts, deletes }

    tab.running = true
    tab.error = null
    try {
      await window.api.db.applyChanges(tab.connectionId, plainTable(tab.table), changeset)
      await reloadTable(tab)
    } catch (e) {
      tab.error = e instanceof Error ? e.message : String(e)
      tab.running = false
    }
  }

  // ---- session persistence (restore open tabs across restarts) --------------
  // A lightweight, serializable view of a tab. Volatile state (result rows,
  // pending edits, undo history) is intentionally dropped — restored tabs
  // re-fetch their data.
  interface TabDescriptor {
    kind: TabKind
    title: string
    query?: string
    table?: TableInfo
    filters?: FilterSpec[]
    sort?: SortSpec
    pageSize?: number
    viewMode?: 'data' | 'structure'
    explorerStack?: ExplorerFocus[]
    explorerIndex?: number
    relatedFocus?: ExplorerFocus
    active?: boolean
  }
  // Kinds worth restoring: content/navigation tabs. Transient or realtime tabs
  // (diffs, chat, redis queues, server views) are recreated on demand instead.
  const RESTORABLE: ReadonlySet<TabKind> = new Set<TabKind>([
    'query',
    'table',
    'explorer',
    'related',
    'analytics',
    'diagram',
    'performance',
    'docs',
    'history',
    'snippets',
    'visualQuery'
  ])
  const TABS_KEY = 'datadock-open-tabs'
  // Connections opened (and thus authoritative) during this session — only
  // these get their saved entry rewritten, so other connections' saved tabs
  // survive even while they're disconnected.
  const sessionConns = new Set<string>()

  function readTabStore(): Record<string, TabDescriptor[]> {
    try {
      return JSON.parse(localStorage.getItem(TABS_KEY) || '{}')
    } catch {
      return {}
    }
  }
  function toDescriptor(t: Tab): TabDescriptor | null {
    if (!RESTORABLE.has(t.kind)) return null
    const d: TabDescriptor = { kind: t.kind, title: t.title }
    if (t.kind === 'query') d.query = t.query
    if (t.kind === 'table' && t.table) {
      d.table = plainTable(t.table)
      d.filters = t.filters.filter((f) => f.column)
      if (t.sort) d.sort = { column: t.sort.column, dir: t.sort.dir }
      d.pageSize = t.pageSize
      d.viewMode = t.viewMode
    }
    if (t.kind === 'explorer') {
      d.explorerStack = t.explorerStack
      d.explorerIndex = t.explorerIndex
    }
    if (t.kind === 'related') d.relatedFocus = t.relatedFocus
    return d
  }
  function descriptorsFor(connId: string): TabDescriptor[] {
    const activeId = activeByConn.value[connId]
    const out: TabDescriptor[] = []
    for (const t of forConnection(connId)) {
      const d = toDescriptor(t)
      if (!d) continue
      if (t.id === activeId) d.active = true
      out.push(d)
    }
    return out
  }

  function persistTabs(): void {
    const store = readTabStore()
    for (const connId of sessionConns) {
      const desc = descriptorsFor(connId)
      if (desc.length) store[connId] = desc
      else delete store[connId]
    }
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(store))
    } catch {
      /* storage full / unavailable — skip */
    }
  }

  /** Recreate saved tabs for a connection (no-op if it already has live tabs). */
  function restoreForConnection(connId: string): void {
    sessionConns.add(connId)
    if (forConnection(connId).length) return
    const saved = readTabStore()[connId]
    if (!saved?.length) return
    let activeId = ''
    for (const d of saved) {
      if (!RESTORABLE.has(d.kind)) continue
      const tab = base(connId, d.kind, d.title)
      if (d.kind === 'query') tab.query = d.query ?? ''
      if (d.kind === 'table' && d.table) {
        tab.table = plainTable(d.table)
        tab.filters = d.filters ?? []
        tab.sort = d.sort
        if (d.pageSize) tab.pageSize = d.pageSize
        tab.viewMode = d.viewMode ?? 'data'
      }
      if (d.kind === 'explorer') {
        tab.explorerStack = d.explorerStack
        tab.explorerIndex = d.explorerIndex ?? 0
      }
      if (d.kind === 'related') tab.relatedFocus = d.relatedFocus
      tabs.value.push(tab)
      const stored = tabs.value[tabs.value.length - 1]
      if (d.active) activeId = stored.id
      // Table tabs need their data (and PKs) fetched; others self-load on render.
      if (stored.kind === 'table' && stored.table) void initTable(stored)
    }
    const list = forConnection(connId)
    activeByConn.value[connId] = activeId || (list.length ? list[list.length - 1].id : '')
  }

  // Persist (debounced) whenever the serializable shape of any tab changes.
  // Using a computed signature keeps the watch off volatile fields like result
  // rows, so loading data doesn't churn localStorage.
  const tabSignature = computed(() =>
    JSON.stringify([...sessionConns].map((c) => [c, descriptorsFor(c)]))
  )
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  watch(tabSignature, () => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(persistTabs, 400)
  })

  return {
    tabs,
    activeByConn,
    forConnection,
    activeTab,
    setActive,
    openQuery,
    openQueryWith,
    explain,
    openTable,
    openServer,
    openHistory,
    openSnippets,
    openDiagram,
    openChat,
    sendChat,
    clearChat,
    dockChatFor,
    openExplorer,
    openRelated,
    restoreForConnection,
    navigateExplorer,
    explorerGoTo,
    openTableFiltered,
    openPerformance,
    openDocs,
    openSearch,
    openAnalytics,
    openEnvDiff,
    openVisualQuery,
    openRedisQueues,
    openSchemaDiff,
    openDataDiff,
    clearHistory,
    savedSnippets,
    matchingSnippet,
    saveSnippet,
    deleteSnippet,
    closeTab,
    closeForConnection,
    run,
    cancel,
    reloadTable,
    setViewMode,
    loadStructure,
    applyAlter,
    nextPage,
    prevPage,
    setPageSize,
    toggleSort,
    setFilters,
    dirtyCount,
    editsAllowed,
    editCell,
    bulkEdit,
    toggleRowSelection,
    toggleSelectAll,
    clearSelection,
    addInsertRow,
    duplicateRow,
    editInsert,
    removeInsert,
    toggleDelete,
    deleteSelectedRows,
    setCellNull,
    isDeleted,
    discardEdits,
    undo,
    redo,
    canUndo,
    canRedo,
    commit
  }
})
