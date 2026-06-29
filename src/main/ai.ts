import type {
  AnalyticsPlan,
  AnalyticsOp,
  AnalyticsOpWidget,
  AnalyticsState,
  ChartEncoding,
  ChartType,
  Aggregation,
  DatasetSource,
  FilterSpec,
  MetricFormat,
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
  cockroachdb: 'CockroachDB (PostgreSQL-compatible SQL)',
  timescaledb: 'TimescaleDB (PostgreSQL SQL with hypertable extensions)',
  redshift: 'Amazon Redshift (PostgreSQL-compatible SQL)',
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

// ---- AI test-data generation ------------------------------------------------

export interface AiSeedRequest {
  driver: string
  table: string
  columns: { name: string; type?: string }[]
  count: number
  hint?: string
}
export interface AiSeedResult {
  rows: Record<string, unknown>[]
}

export async function generateSeedData(req: AiSeedRequest): Promise<AiSeedResult> {
  const d = dialect(req.driver)
  const colList = req.columns
    .map((c) => `- ${c.name}${c.type ? ` (${c.type})` : ''}`)
    .join('\n')
  const n = Math.max(1, Math.min(100, Math.floor(req.count) || 1))
  const system =
    `You generate realistic, internally-consistent sample data for seeding a ${d} table. ` +
    `Return ONLY a JSON array of exactly ${n} row objects, each keyed by the given column names. ` +
    `Make values plausible and varied — real-looking names, emails, companies, addresses, prices, ` +
    `and ISO-8601 strings for dates/timestamps. Respect each column's type. Use null only where a ` +
    `value is genuinely optional. Do not include any column not listed. No markdown, no commentary.`
  const user =
    `Table: ${req.table}\nColumns:\n${colList}\n\nGenerate ${n} rows as a JSON array.` +
    (req.hint ? `\nExtra guidance: ${req.hint}` : '')
  return { rows: parseRows(await complete({ system, user })) }
}

// ---- AI schema docs (one-line purpose per table) ----------------------------

export interface AiDescribeRequest {
  driver: string
  tables: { name: string; columns: string[] }[]
}

export async function describeSchema(req: AiDescribeRequest): Promise<Record<string, string>> {
  const d = dialect(req.driver)
  const list = req.tables.map((t) => `${t.name}(${t.columns.join(', ')})`).join('\n')
  const system =
    `You document ${d} database schemas. For each table, infer its purpose from its name and ` +
    `columns (and relationships between tables) and write ONE concise, plain-English sentence ` +
    `describing what it stores. Don't restate the column list. ` +
    `Respond with ONLY a JSON object mapping each table name to its description string. No markdown.`
  const user = `Tables:\n${list}`
  const text = await complete({ system, user })
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try {
    const obj = JSON.parse(cleaned)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v.trim()
      return out
    }
  } catch {
    /* ignore — return nothing rather than break the docs */
  }
  return {}
}

function parseRows(text: string): Record<string, unknown>[] {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const tryParse = (s: string): Record<string, unknown>[] | null => {
    try {
      const data = JSON.parse(s)
      if (Array.isArray(data)) return data.filter((r) => r && typeof r === 'object')
    } catch {
      /* fall through */
    }
    return null
  }
  const direct = tryParse(cleaned)
  if (direct) return direct
  // Models sometimes add prose around the array — extract the first [...] block.
  const m = cleaned.match(/\[[\s\S]*\]/)
  return (m && tryParse(m[0])) || []
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

// ---- replication advisor ----------------------------------------------------

export interface AiReplicaNode {
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
}
export interface AiReplicationAdviceRequest {
  topology: string
  warnSeconds: number
  critSeconds: number
  nodes: AiReplicaNode[]
}

function fmtSeconds(s?: number | null): string {
  if (s == null) return 'unknown'
  if (s < 1) return `${Math.round(s * 1000)}ms`
  if (s < 90) return `${s.toFixed(1)}s`
  return `${Math.round(s / 60)}m`
}

function replicaNodeText(n: AiReplicaNode): string {
  const bits: string[] = [`- ${n.name} [${n.driver}] — assigned role: ${n.assignedRole}`]
  if (n.notConnected) {
    bits.push('  status: NOT CONNECTED in the client (no live reading)')
  } else if (n.unreachable) {
    bits.push(`  status: UNREACHABLE${n.error ? ` (${n.error})` : ''}`)
  } else {
    if (n.detectedRole) bits.push(`  engine-detected role: ${n.detectedRole}${n.isPrimary ? ' (primary)' : ''}`)
    if (!n.isPrimary) bits.push(`  apply lag: ${fmtSeconds(n.lagSeconds)}`)
    if (n.position) bits.push(`  position: ${n.position}`)
    if (n.replicas?.length)
      bits.push(
        `  downstream replicas: ${n.replicas
          .map((r) => `${r.name} (${r.state ?? '?'}, lag ${fmtSeconds(r.lagSeconds)})`)
          .join('; ')}`
      )
    if (n.managedBy) bits.push(`  managed by: ${n.managedBy}`)
    if (n.error) bits.push(`  note: ${n.error}`)
    if (n.detail?.length) bits.push(`  detail: ${n.detail.join(' · ')}`)
  }
  return bits.join('\n')
}

export async function adviseReplication(req: AiReplicationAdviceRequest): Promise<string> {
  const anyManaged = req.nodes.some((n) => n.managedBy)
  const system =
    `You are a senior database reliability engineer (SRE) embedded in a database client. ` +
    `You are given a live snapshot of a replication topology. Diagnose it for the operator:\n` +
    `1) Give a one-line overall health verdict.\n` +
    `2) For each problem, state the most likely cause and concrete, SAFE next steps.\n` +
    `Rules: when you suggest a command, give the exact command in backticks but make clear it is ADVISORY — ` +
    `the operator runs it; this tool executes nothing. Prefer non-destructive diagnostics first. ` +
    `NEVER recommend a manual failover/promotion (pg_promote, rs.stepDown, STOP/RESET REPLICA, REPLICAOF NO ONE) ` +
    `on a managed or orchestrated cluster (Amazon RDS/Aurora, MongoDB Atlas, Patroni, repmgr, MySQL Group ` +
    `Replication) — there, tell them to use the platform's own failover tooling instead. ` +
    `Lag thresholds for this topology: amber ≥ ${req.warnSeconds}s, red ≥ ${req.critSeconds}s. ` +
    `Remember MySQL Seconds_Behind_Source is unreliable (0 on idle, NULL when a thread stops). ` +
    `Be concise and practical; use short markdown sections and bullets. If everything is healthy, say so in a sentence or two.`
  const user =
    `Topology: ${req.topology}\n` +
    (anyManaged
      ? `(One or more nodes run on a managed/orchestrated platform — do not advise manual failover on those.)\n`
      : '') +
    `\nNodes:\n${req.nodes.map(replicaNodeText).join('\n')}`
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

const CHART_TYPES: ChartType[] = ['bar', 'hbar', 'line', 'area', 'pie', 'donut', 'kpi', 'table', 'pivot']
const AGGS: Aggregation[] = ['count', 'sum', 'avg', 'min', 'max']
const BUCKETS = ['none', 'day', 'week', 'month', 'quarter', 'year']
const FILTER_OPS = new Set(['=', '!=', '<', '<=', '>', '>=', 'contains', 'starts', 'is null', 'not null'])
const FORMAT_STYLES = new Set(['plain', 'currency', 'percent'])
const OP_KINDS = new Set([
  'createDataset', 'updateDataset', 'deleteDataset',
  'createMetric', 'updateMetric', 'deleteMetric',
  'createChart', 'updateChart', 'deleteChart',
  'createDashboard', 'updateDashboard', 'deleteDashboard'
])

function parseFilters(raw: unknown): FilterSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: FilterSpec[] = []
  for (const f of raw as Record<string, unknown>[]) {
    if (!f?.column || !FILTER_OPS.has(String(f.op))) continue
    out.push({
      column: String(f.column),
      op: String(f.op) as FilterSpec['op'],
      value: f.value !== undefined ? String(f.value) : undefined
    })
  }
  return out.length ? out : undefined
}
function parseFormat(raw: unknown): MetricFormat | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const f = raw as Record<string, unknown>
  const style = FORMAT_STYLES.has(String(f.style)) ? (f.style as MetricFormat['style']) : undefined
  const fmt: MetricFormat = {
    style,
    decimals: typeof f.decimals === 'number' ? f.decimals : undefined,
    prefix: f.prefix !== undefined ? String(f.prefix) : undefined,
    suffix: f.suffix !== undefined ? String(f.suffix) : undefined
  }
  return style || fmt.decimals !== undefined || fmt.prefix || fmt.suffix ? fmt : undefined
}

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
    limit: typeof enc.limit === 'number' ? enc.limit : undefined,
    metricId: enc.metricId ? String(enc.metricId) : undefined
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
      case 'createMetric': {
        const agg = AGGS.includes(r.agg as Aggregation) ? (r.agg as Aggregation) : 'count'
        if (!r.name || (!r.datasetId && !r.datasetKey)) continue
        ops.push({
          op: 'createMetric',
          key: r.key ? String(r.key) : undefined,
          name: String(r.name),
          datasetId: r.datasetId ? String(r.datasetId) : undefined,
          datasetKey: r.datasetKey ? String(r.datasetKey) : undefined,
          agg,
          column: r.column ? String(r.column) : undefined,
          filters: parseFilters(r.filters),
          format: parseFormat(r.format),
          icon: r.icon ? String(r.icon) : undefined
        })
        break
      }
      case 'updateMetric': {
        if (!r.id) continue
        ops.push({
          op: 'updateMetric',
          id: String(r.id),
          name: r.name ? String(r.name) : undefined,
          datasetId: r.datasetId ? String(r.datasetId) : undefined,
          datasetKey: r.datasetKey ? String(r.datasetKey) : undefined,
          agg: AGGS.includes(r.agg as Aggregation) ? (r.agg as Aggregation) : undefined,
          column: r.column !== undefined ? String(r.column) : undefined,
          filters: parseFilters(r.filters),
          format: parseFormat(r.format),
          icon: r.icon !== undefined ? String(r.icon) : undefined
        })
        break
      }
      case 'deleteMetric':
        if (r.id) ops.push({ op: 'deleteMetric', id: String(r.id) })
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
    `- {"op":"createMetric","key":"m1","name":"...","datasetKey":"d1" OR "datasetId":"...","agg":"count|sum|avg|min|max","column?":"<measure col>","format?":<format>,"icon?":"<emoji>"}\n` +
    `- {"op":"updateMetric","id":"...","name?":"...","agg?":"...","column?":"...","format?":<format>,"icon?":"<emoji>"}\n` +
    `- {"op":"deleteMetric","id":"..."}\n` +
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
    `"kpi" for a single headline number (a card; give it a relevant "icon" emoji), "table" for raw rows, ` +
    `"pivot" for a rows × columns cross-tab (set encoding.x = the row dimension and encoding.series = the column dimension; measure in cells).\n` +
    `<encoding>: {"x":"<dimension col, omit for kpi>","bucket":"none|day|week|month|quarter|year","yAgg":"count|sum|avg|min|max",` +
    `"yColumn":"<measure col, required unless count>","series":"<optional split col>","limit":<max rows>,"metricId?":"<bind measure to a saved metric id/key>"}. ` +
    `<format> (for metric display): {"style":"plain|currency|percent","decimals":<n>,"prefix?":"...","suffix?":"..."}.\n` +
    `A METRIC is a reusable named measure. Prefer creating a metric and binding KPI cards/charts to it (encoding.metricId) when the same number is reused, ` +
    `e.g. "total revenue". For a standalone headline number a kpi chart with a direct yAgg/yColumn is also fine.\n` +
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
  /** Opaque id echoed back with streamed deltas so the renderer can route them. */
  streamId?: string
}
export interface AiChatResult {
  answer: string
  steps: ChatStep[]
}

/**
 * Answer questions about the live database. The caller supplies `runSql`, a
 * read-only query runner bound to the active connection; the model may call it
 * to inspect real data before replying. `onDelta` (optional) receives answer
 * text as it streams.
 */
export async function chat(
  req: AiChatRequest,
  runSql: RunSql,
  onDelta?: (text: string) => void
): Promise<AiChatResult> {
  const d = dialect(req.driver)
  const system =
    `You are a helpful data analyst embedded in a database client, connected to a ${d} database. ` +
    `Answer the user's questions about THEIR data. You can call the run_sql tool to execute ` +
    `READ-ONLY queries (SELECT / WITH / EXPLAIN / SHOW) and inspect real rows before answering — ` +
    `do this whenever a question depends on the actual data. Never try to modify data. ` +
    `When you state figures, base them on query results, not guesses. Keep answers concise and ` +
    `include small result tables or numbers where helpful.\n\nDatabase schema:\n${schemaText(req.schema)}`
  return chatWithData({ system, history: req.history, runSql, onDelta })
}
