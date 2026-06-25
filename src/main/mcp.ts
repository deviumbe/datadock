// Local MCP server. Exposes the user's database connections to an external AI
// agent (e.g. Claude Code) over a loopback-only Streamable-HTTP endpoint, so the
// agent can discover schemas and run read-only queries against live connections.
//
// Safety model:
//  - OFF by default; `enabled` is a hard kill-switch (port is closed when off).
//  - Binds to 127.0.0.1 only and requires a bearer token on every request.
//  - Per-connection `mcpExcluded` hides a connection entirely.
//  - Read-only by default; writes need the global `allowWrites` opt-in AND a
//    connection that is not marked read-only / production.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { ConnectionConfig, McpInfo, QueryResult, TableInfo } from '@shared/types'
import * as store from './storage'
import * as db from './db'
import * as settings from './settings'
import { prepareStatement } from './sqlGuard'

let httpServer: Server | undefined
let lastError: string | undefined

// ---- helpers ----------------------------------------------------------------

/** Connections visible to MCP (excludes any flagged `mcpExcluded`). */
function visibleConnections(): ConnectionConfig[] {
  return store.allConnections().filter((c) => !c.mcpExcluded)
}

/** Resolve an agent-supplied identifier (id or unique name) to a connection. */
function resolveTarget(identifier: string): ConnectionConfig {
  const conns = visibleConnections()
  const byId = conns.find((c) => c.id === identifier)
  if (byId) return byId
  const byName = conns.filter((c) => c.name === identifier)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(`Multiple connections named "${identifier}" — use the connection id instead.`)
  }
  throw new Error(`No accessible connection "${identifier}". Call list_connections first.`)
}

/** Open the connection if it isn't already (read-only access still applies). */
async function ensureConnected(conn: ConnectionConfig): Promise<void> {
  if (db.isConnected(conn.id)) return
  await db.connect(store.resolveConnection(conn.id))
}

/** True when writes must be blocked for this connection. */
function readOnlyFor(conn: ConnectionConfig): boolean {
  const allowWrites = settings.getMcpSettings().allowWrites
  return !(allowWrites && !conn.readOnly && !conn.production)
}

/** Compact, token-bounded rendering of a result set. */
function renderResult(res: QueryResult, rowCap = 500): string {
  const cols = res.columns.map((c) => c.name)
  const rows = res.rows.slice(0, rowCap)
  const truncated = res.rows.length > rowCap
  return JSON.stringify(
    {
      columns: cols,
      rows: rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]]))),
      rowCount: res.rowCount,
      truncated: truncated ? `showing first ${rowCap} of ${res.rows.length}` : undefined,
      durationMs: res.durationMs
    },
    null,
    2
  )
}

const ok = (text: string): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text }]
})

// ---- server definition ------------------------------------------------------

/** Build a fresh MCP server with the DataDock tools (stateless: one per request). */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'datadock', version: '0.1.1' },
    {
      instructions:
        'DataDock exposes the user\'s database connections. Call list_connections to ' +
        'discover them, then list_tables / describe_table / run_query against a connection ' +
        'by its id or name. Queries are read-only unless the user has enabled writes.'
    }
  )

  server.registerTool(
    'list_connections',
    {
      title: 'List database connections',
      description:
        'List the database connections the user has shared with MCP (id, name, engine, ' +
        'database, and whether currently connected).',
      inputSchema: {}
    },
    async () => {
      const list = visibleConnections().map((c) => ({
        id: c.id,
        name: c.name,
        driver: c.driver,
        database: c.database ?? c.filePath ?? null,
        connected: db.isConnected(c.id),
        readOnly: !!c.readOnly,
        production: !!c.production
      }))
      return ok(JSON.stringify(list, null, 2))
    }
  )

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description: 'List the tables/collections in a connection (id or name).',
      inputSchema: { connection: z.string().describe('Connection id or name') }
    },
    async ({ connection }) => {
      const conn = resolveTarget(connection)
      await ensureConnected(conn)
      const tables = await db.getAdapter(conn.id).listTables()
      return ok(JSON.stringify(tables, null, 2))
    }
  )

  server.registerTool(
    'describe_table',
    {
      title: 'Describe a table',
      description: 'Return columns, types, primary keys, foreign keys and indexes for a table.',
      inputSchema: {
        connection: z.string().describe('Connection id or name'),
        table: z.string().describe('Table name'),
        schema: z.string().optional().describe('Schema name, if the engine uses schemas')
      }
    },
    async ({ connection, table, schema }) => {
      const conn = resolveTarget(connection)
      await ensureConnected(conn)
      const adapter = db.getAdapter(conn.id)
      if (typeof adapter.tableStructure !== 'function') {
        throw new Error(`${conn.driver} does not support describe_table.`)
      }
      const info: TableInfo = { name: table, schema, type: 'table' }
      const structure = await adapter.tableStructure(info)
      return ok(JSON.stringify(structure, null, 2))
    }
  )

  server.registerTool(
    'run_query',
    {
      title: 'Run a query',
      description:
        'Run a single SQL statement (or engine command) against a connection and return rows. ' +
        'Read-only unless the user has enabled writes for MCP.',
      inputSchema: {
        connection: z.string().describe('Connection id or name'),
        sql: z.string().describe('A single SQL statement / engine command to execute')
      }
    },
    async ({ connection, sql }) => {
      const conn = resolveTarget(connection)
      await ensureConnected(conn)
      const statement = prepareStatement(conn.driver, sql, readOnlyFor(conn))
      const res = await db.getAdapter(conn.id).query(statement)
      return ok(renderResult(res))
    }
  )

  return server
}

// ---- HTTP transport ---------------------------------------------------------

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Unauthorized — missing or invalid bearer token.' }))
}

function authed(req: IncomingMessage): boolean {
  const token = settings.getMcpSettings().token
  if (!token) return false
  const header = req.headers['authorization']
  return header === `Bearer ${token}`
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The Streamable-HTTP client posts JSON-RPC to a single endpoint. We run
  // stateless: a new server + transport per request (no session affinity needed
  // for a single local client), so GET/DELETE session streams aren't supported.
  const url = req.url ?? '/'
  if (!url.startsWith('/mcp')) {
    res.writeHead(404).end()
    return
  }
  if (!authed(req)) return unauthorized(res)
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ error: 'Only POST is supported (stateless server).' })
    )
    return
  }

  const server = buildServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    const body = await readBody(req)
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
      )
    }
  }
}

// ---- lifecycle --------------------------------------------------------------

export function isRunning(): boolean {
  return !!httpServer?.listening
}

export function getMcpInfo(): McpInfo {
  return { ...settings.getMcpSettings(), running: isRunning(), error: lastError }
}

export function stopMcp(): void {
  if (httpServer) {
    httpServer.close()
    httpServer = undefined
  }
}

/** Start (or restart) the server from current settings. No-op when disabled. */
export function startMcp(): McpInfo {
  stopMcp()
  lastError = undefined
  const cfg = settings.getMcpSettings()
  if (!cfg.enabled) return getMcpInfo()
  if (!cfg.token) {
    lastError = 'No token configured.'
    return getMcpInfo()
  }
  const srv = createServer((req, res) => void handle(req, res))
  srv.on('error', (err) => {
    lastError = err instanceof Error ? err.message : String(err)
    httpServer = undefined
  })
  // 127.0.0.1 only — never expose the endpoint beyond the local machine.
  srv.listen(cfg.port, '127.0.0.1')
  httpServer = srv
  return getMcpInfo()
}

// ---- settings-mutating actions (called from IPC) ----------------------------

export function setEnabled(enabled: boolean): McpInfo {
  settings.setMcpSettings({ enabled })
  return startMcp()
}

export function setConfig(partial: { port?: number; allowWrites?: boolean }): McpInfo {
  const before = settings.getMcpSettings()
  settings.setMcpSettings(partial)
  // Port change requires a rebind; allowWrites is read live per request.
  if (isRunning() && partial.port !== undefined && partial.port !== before.port) startMcp()
  return getMcpInfo()
}

export function regenerateToken(): McpInfo {
  settings.regenerateMcpToken()
  // Token is validated live per request, so no restart is needed.
  return getMcpInfo()
}
