import type {
  AnalyticsPlan,
  AnalyticsOp,
  AnalyticsOpWidget,
  AnalyticsState,
  ChartEncoding,
  ChartType,
  Aggregation,
  DatasetSource,
  ChatStep
} from '@shared/types'
import { complete, chatWithData, type ChatTurn, type RunSql } from './aiProviders'
import {
  activeProviderReady,
  clearProviderKey,
  getSettings,
  setProviderKey
} from './settings'

// The AI assistant turns natural language into SQL, explains/fixes queries, and
// powers the "chat with your data" feature. Provider selection, keys (encrypted
// at rest) and models all live in settings.ts; this module just builds prompts
// and delegates to the active provider via aiProviders.ts.

// ---- key helpers (operate on the active provider, for the inline assistant) -
export function hasAiKey(): boolean {
  return activeProviderReady()
}
export function setAiKey(key: string): boolean {
  setProviderKey(getSettings().ai.activeProvider, key)
  return true
}
export function clearAiKey(): boolean {
  clearProviderKey(getSettings().ai.activeProvider)
  return true
}

const DIALECT: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  mssql: 'Microsoft SQL Server (T-SQL)',
  influxdb: 'InfluxDB Flux',
  mongodb: 'MongoDB (shell-style queries)'
}
const dialect = (d: string): string => DIALECT[d] ?? d

function schemaText(schema: Record<string, string[]>): string {
  const tables = Object.entries(schema)
  if (tables.length === 0) return '(schema unavailable)'
  return tables.map(([t, cols]) => `${t}(${cols.join(', ')})`).join('\n')
}

export interface AiSqlRequest {
  driver: string
  schema: Record<string, string[]>
  prompt: string
}
export interface AiSqlResult {
  sql: string
  notes: string
}

function parseSql(text: string): AiSqlResult {
  // Models occasionally wrap JSON in markdown fences — strip them first.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try {
    const parsed = JSON.parse(cleaned) as AiSqlResult
    return { sql: (parsed.sql ?? '').trim(), notes: parsed.notes ?? '' }
  } catch {
    return { sql: cleaned, notes: '' }
  }
}

export async function generateSql(req: AiSqlRequest): Promise<AiSqlResult> {
  const d = dialect(req.driver)
  const system =
    `You are an expert ${d} query author embedded in a database client. ` +
    `Translate the user's request into a single, runnable ${d} query. ` +
    `Use only tables and columns that appear in the provided schema; never invent names. ` +
    `Prefer explicit column lists over SELECT * when the intent is specific. ` +
    `Respond with ONLY a JSON object (no markdown fences): {"sql": "<the query, no trailing semicolon>", ` +
    `"notes": "<one short sentence on assumptions or caveats, may be empty>"}.`
  const user = `Database schema:\n${schemaText(req.schema)}\n\nRequest: ${req.prompt}`
  return parseSql(await complete({ system, user }))
}

export interface AiExplainRequest {
  driver: string
  schema: Record<string, string[]>
  sql: string
}

export async function explainQuery(req: AiExplainRequest): Promise<string> {
  const d = dialect(req.driver)
  const system =
    `You are a senior database engineer. Explain what the given ${d} query does in clear, ` +
    `plain English for a developer. Cover the tables involved, joins, filters, grouping/ordering, ` +
    `and call out any obvious performance concerns (missing indexes, full scans, cartesian joins). ` +
    `Be concise — a few short paragraphs or bullet points. Do not restate the SQL verbatim.`
  const user = `Database schema:\n${schemaText(req.schema)}\n\nQuery:\n${req.sql}`
  return (await complete({ system, user })).trim()
}

export interface AiFixRequest {
  driver: string
  schema: Record<string, string[]>
  sql: string
  error: string
}

export async function fixQuery(req: AiFixRequest): Promise<AiSqlResult> {
  const d = dialect(req.driver)
  const system =
    `A ${d} query failed. Given the schema, the query, and the database error message, return a ` +
    `corrected query that resolves the error while preserving the original intent. Use only tables and ` +
    `columns from the schema. Respond with ONLY a JSON object (no markdown fences): ` +
    `{"sql": "<corrected query>", "notes": "<one short sentence on what you changed>"}.`
  const user =
    `Database schema:\n${schemaText(req.schema)}\n\nFailing query:\n${req.sql}\n\nError:\n${req.error}`
  return parseSql(await complete({ system, user }))
}

// ---- AI-built analytics ------------------------------------------------------

export interface AiAnalyticsRequest {
  driver: string
  schema: Record<string, string[]>
  prompt: string
  /** The connection's current analytics objects, so the AI can edit/fix in place. */
  state?: AnalyticsState
}

const CHART_TYPES: ChartType[] = ['bar', 'hbar', 'line', 'area', 'pie', 'donut', 'kpi', 'table']
const AGGS: Aggregation[] = ['count', 'sum', 'avg', 'min', 'max']
const BUCKETS = ['none', 'day', 'week', 'month', 'quarter', 'year']
const OP_KINDS = new Set([
  'createDataset', 'updateDataset', 'deleteDataset',
  'createChart', 'updateChart', 'deleteChart',
  'createDashboard', 'updateDashboard', 'deleteDashboard'
])

function parseSource(src: Record<string, unknown> | undefined): DatasetSource | undefined {
  if (!src?.kind) return undefined
  if (src.kind === 'sql' && src.sql) return { kind: 'sql', sql: String(src.sql).replace(/;\s*$/, '') }
  if ((src.kind === 'table' || src.kind === 'view') && src.table) {
    return { kind: src.kind, table: String(src.table) }
  }
  return undefined
}
function parseEncoding(enc: Record<string, unknown>): ChartEncoding {
  return {
    x: enc.x ? String(enc.x) : undefined,
    bucket: BUCKETS.includes(enc.bucket as string) ? (enc.bucket as never) : 'none',
    yAgg: AGGS.includes(enc.yAgg as Aggregation) ? (enc.yAgg as Aggregation) : 'count',
    yColumn: enc.yColumn ? String(enc.yColumn) : undefined,
    series: enc.series ? String(enc.series) : undefined,
    limit: typeof enc.limit === 'number' ? enc.limit : undefined
  }
}
function parseWidgets(raw: unknown): AnalyticsOpWidget[] {
  if (!Array.isArray(raw)) return []
  const out: AnalyticsOpWidget[] = []
  for (const w of raw as Record<string, unknown>[]) {
    if (!w?.chartId && !w?.chartKey) continue
    out.push({
      chartId: w.chartId ? String(w.chartId) : undefined,
      chartKey: w.chartKey ? String(w.chartKey) : undefined,
      x: typeof w.x === 'number' ? w.x : undefined,
      y: typeof w.y === 'number' ? w.y : undefined,
      w: typeof w.w === 'number' ? w.w : undefined,
      h: typeof w.h === 'number' ? w.h : undefined
    })
  }
  return out
}

function parseAnalytics(text: string): AnalyticsPlan {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  let raw: unknown
  try {
    raw = JSON.parse(cleaned)
  } catch {
    throw new Error('The AI returned a response that was not valid JSON.')
  }
  const obj = raw as Record<string, unknown>
  const rawOps = Array.isArray(obj.ops) ? obj.ops : []
  const ops: AnalyticsOp[] = []
  for (const r of rawOps as Record<string, unknown>[]) {
    const kind = String(r?.op ?? '')
    if (!OP_KINDS.has(kind)) continue
    const type = CHART_TYPES.includes(r.type as ChartType) ? (r.type as ChartType) : 'bar'
    switch (kind) {
      case 'createDataset': {
        const source = parseSource(r.source as Record<string, unknown>)
        if (!r.key || !r.name || !source) continue
        ops.push({ op: 'createDataset', key: String(r.key), name: String(r.name), source })
        break
      }
      case 'updateDataset': {
        if (!r.id) continue
        ops.push({
          op: 'updateDataset',
          id: String(r.id),
          name: r.name ? String(r.name) : undefined,
          source: parseSource(r.source as Record<string, unknown>)
        })
        break
      }
      case 'deleteDataset':
        if (r.id) ops.push({ op: 'deleteDataset', id: String(r.id) })
        break
      case 'createChart': {
        if (!r.name || (!r.datasetId && !r.datasetKey)) continue
        ops.push({
          op: 'createChart',
          key: r.key ? String(r.key) : undefined,
          name: String(r.name),
          datasetId: r.datasetId ? String(r.datasetId) : undefined,
          datasetKey: r.datasetKey ? String(r.datasetKey) : undefined,
          type,
          encoding: parseEncoding((r.encoding ?? {}) as Record<string, unknown>),
          icon: r.icon ? String(r.icon) : undefined
        })
        break
      }
      case 'updateChart': {
        if (!r.id) continue
        ops.push({
          op: 'updateChart',
          id: String(r.id),
          name: r.name ? String(r.name) : undefined,
          datasetId: r.datasetId ? String(r.datasetId) : undefined,
          datasetKey: r.datasetKey ? String(r.datasetKey) : undefined,
          type: CHART_TYPES.includes(r.type as ChartType) ? (r.type as ChartType) : undefined,
          encoding: r.encoding ? parseEncoding(r.encoding as Record<string, unknown>) : undefined,
          icon: r.icon !== undefined ? String(r.icon) : undefined
        })
        break
      }
      case 'deleteChart':
        if (r.id) ops.push({ op: 'deleteChart', id: String(r.id) })
        break
      case 'createDashboard': {
        if (!r.name) continue
        ops.push({
          op: 'createDashboard',
          key: r.key ? String(r.key) : undefined,
          name: String(r.name),
          widgets: parseWidgets(r.widgets)
        })
        break
      }
      case 'updateDashboard': {
        if (!r.id) continue
        ops.push({
          op: 'updateDashboard',
          id: String(r.id),
          name: r.name ? String(r.name) : undefined,
          widgets: r.widgets !== undefined ? parseWidgets(r.widgets) : undefined
        })
        break
      }
      case 'deleteDashboard':
        if (r.id) ops.push({ op: 'deleteDashboard', id: String(r.id) })
        break
    }
  }

  if (!ops.length) throw new Error('The AI did not return any actionable analytics changes.')
  return { ops, notes: typeof obj.notes === 'string' ? obj.notes : undefined }
}

function stateText(state?: AnalyticsState): string {
  if (!state || (!state.datasets.length && !state.charts.length && !state.dashboards.length)) {
    return '(no analytics objects exist yet)'
  }
  return JSON.stringify(state)
}

/**
 * Turn a natural-language request into an ordered plan of operations (create /
 * update / delete datasets, charts and dashboards). The model is given the
 * current analytics objects so it can EDIT or FIX existing ones in place by id
 * rather than always creating new ones.
 */
export async function generateAnalytics(req: AiAnalyticsRequest): Promise<AnalyticsPlan> {
  const d = dialect(req.driver)
  const system =
    `You are a data-visualization expert embedded in a database client connected to a ${d} database. ` +
    `Turn the user's request into an ordered list of operations on the analytics workspace. ` +
    `Respond with ONLY a JSON object (no markdown fences): {"ops":[<op>, ...],"notes":"<1-2 sentence summary>"}.\n\n` +
    `Each <op> has an "op" field. New objects use a local "key" that later ops can reference; existing ` +
    `objects (from CURRENT STATE below) are targeted by their real "id". Operations:\n` +
    `- {"op":"createDataset","key":"d1","name":"...","source":<source>}\n` +
    `- {"op":"updateDataset","id":"...","name?":"...","source?":<source>}\n` +
    `- {"op":"deleteDataset","id":"..."}\n` +
    `- {"op":"createChart","key":"c1","name":"...","datasetKey":"d1" OR "datasetId":"...","type":<chartType>,"encoding":<encoding>,"icon?":"<emoji, kpi only>"}\n` +
    `- {"op":"updateChart","id":"...","name?":"...","type?":<chartType>,"encoding?":<encoding>,"datasetId?":"...","icon?":"<emoji>"}\n` +
    `- {"op":"deleteChart","id":"..."}\n` +
    `- {"op":"createDashboard","key":"b1","name":"...","widgets":[{"chartKey":"c1" OR "chartId":"...","x":0,"y":0,"w":6,"h":8}]}\n` +
    `- {"op":"updateDashboard","id":"...","name?":"...","widgets?":[...]}\n` +
    `- {"op":"deleteDashboard","id":"..."}\n\n` +
    `CRITICAL: To fix or change something that already exists, UPDATE it by its id — never create a duplicate. ` +
    `When the user references "this chart/the sales chart/the dashboard", find it in CURRENT STATE and update that id.\n\n` +
    `A <source> is {"kind":"table","table":"..."}, {"kind":"view","table":"..."} or {"kind":"sql","sql":"<${d} SELECT, no trailing semicolon>"}. ` +
    `Use "sql" for joins, derived columns, pre-filtering or TOP-N (e.g. WHERE id IN (SELECT ... ORDER BY SUM(...) DESC LIMIT 10)). ` +
    `Dataset SQL MUST return ROW-LEVEL data (dimension, measure, optional series columns) and must NOT pre-aggregate — the app aggregates.\n` +
    `<chartType>: ${CHART_TYPES.join(', ')}. Use "line" for time trends, "bar" for category comparisons, "pie"/"donut" for share, ` +
    `"kpi" for a single headline number (a card; give it a relevant "icon" emoji), "table" for raw rows.\n` +
    `<encoding>: {"x":"<dimension col, omit for kpi>","bucket":"none|day|week|month|quarter|year","yAgg":"count|sum|avg|min|max",` +
    `"yColumn":"<measure col, required unless count>","series":"<optional split col>","limit":<max rows>}. ` +
    `Every column named in an encoding MUST be an output column of its dataset. Use only tables/columns from the schema; never invent names.\n` +
    `When building a dashboard, lay KPI cards (w=3,h=4) in a top row and larger charts (w=6,h=8) below on a 12-column grid; x/y optional (auto-arranged).`
  const user =
    `Database schema:\n${schemaText(req.schema)}\n\n` +
    `CURRENT STATE (existing analytics objects you can update/delete by id):\n${stateText(req.state)}\n\n` +
    `Request: ${req.prompt}`
  return parseAnalytics(await complete({ system, user }))
}

// ---- chat with your data ----------------------------------------------------

export interface AiChatRequest {
  driver: string
  schema: Record<string, string[]>
  history: ChatTurn[]
}
export interface AiChatResult {
  answer: string
  steps: ChatStep[]
}

/**
 * Answer questions about the live database. The caller supplies `runSql`, a
 * read-only query runner bound to the active connection; the model may call it
 * to inspect real data before replying.
 */
export async function chat(req: AiChatRequest, runSql: RunSql): Promise<AiChatResult> {
  const d = dialect(req.driver)
  const system =
    `You are a helpful data analyst embedded in a database client, connected to a ${d} database. ` +
    `Answer the user's questions about THEIR data. You can call the run_sql tool to execute ` +
    `READ-ONLY queries (SELECT / WITH / EXPLAIN / SHOW) and inspect real rows before answering — ` +
    `do this whenever a question depends on the actual data. Never try to modify data. ` +
    `When you state figures, base them on query results, not guesses. Keep answers concise and ` +
    `include small result tables or numbers where helpful.\n\nDatabase schema:\n${schemaText(req.schema)}`
  return chatWithData({ system, history: req.history, runSql })
}
