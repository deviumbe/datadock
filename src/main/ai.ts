import type { ChatStep } from '@shared/types'
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
