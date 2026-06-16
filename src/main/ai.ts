import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'

// The AI assistant turns natural language into SQL via the Anthropic API. The key
// is held only in the main process — encrypted at rest with safeStorage, exactly
// like connection secrets — and never sent to the renderer (which only learns
// whether a key is set).

const MODEL = 'claude-opus-4-8'

let keyPath: string | undefined
function path(): string {
  if (!keyPath) keyPath = join(app.getPath('userData'), 'ai.json')
  return keyPath
}

function encrypt(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) return `plain:${plain}`
  return `enc:${safeStorage.encryptString(plain).toString('base64')}`
}
function decrypt(stored: string | undefined): string | undefined {
  if (!stored) return undefined
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    if (stored.startsWith('plain:')) return stored.slice(6)
  } catch {
    return undefined
  }
  return undefined
}

function readKey(): string | undefined {
  const p = path()
  if (!existsSync(p)) return undefined
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8')) as { apiKey?: string }
    return decrypt(data.apiKey)
  } catch {
    return undefined
  }
}

export function hasAiKey(): boolean {
  return !!readKey()
}

export function setAiKey(key: string): boolean {
  const trimmed = key.trim()
  if (!trimmed) {
    clearAiKey()
    return false
  }
  writeFileSync(path(), JSON.stringify({ apiKey: encrypt(trimmed) }, null, 2), 'utf-8')
  return true
}

export function clearAiKey(): boolean {
  writeFileSync(path(), JSON.stringify({}, null, 2), 'utf-8')
  return true
}

const DIALECT: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  mssql: 'Microsoft SQL Server (T-SQL)',
  influxdb: 'InfluxDB Flux'
}

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

function makeClient(): { client: Anthropic; dialect: (d: string) => string } {
  const apiKey = readKey()
  if (!apiKey) throw new Error('No Anthropic API key set. Add one in AI settings.')
  return { client: new Anthropic({ apiKey }), dialect: (d) => DIALECT[d] ?? d }
}

const SQL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sql: { type: 'string' },
    notes: { type: 'string' }
  },
  required: ['sql', 'notes']
}

function textOf(response: Anthropic.Message): string {
  if (response.stop_reason === 'refusal') {
    throw new Error('The request was declined by the model. Try rephrasing.')
  }
  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('The model returned no text.')
  return block.text
}

export async function generateSql(req: AiSqlRequest): Promise<AiSqlResult> {
  const { client, dialect: d } = makeClient()
  const dialect = d(req.driver)

  const system =
    `You are an expert ${dialect} query author embedded in a database client. ` +
    `Translate the user's request into a single, runnable ${dialect} query. ` +
    `Use only tables and columns that appear in the provided schema; never invent names. ` +
    `Prefer explicit column lists over SELECT * when the intent is specific. ` +
    `Do not wrap the query in markdown fences. Respond with JSON: "sql" is the query ` +
    `(no trailing semicolon required), "notes" is one short sentence on assumptions or caveats (may be empty).`

  const user = `Database schema:\n${schemaText(req.schema)}\n\nRequest: ${req.prompt}`

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: SQL_SCHEMA } }
  } as Anthropic.MessageCreateParamsNonStreaming)

  return parseSql(textOf(response))
}

function parseSql(text: string): AiSqlResult {
  try {
    const parsed = JSON.parse(text) as AiSqlResult
    return { sql: (parsed.sql ?? '').trim(), notes: parsed.notes ?? '' }
  } catch {
    // Fall back to treating the whole response as the query.
    return { sql: text.trim(), notes: '' }
  }
}

export interface AiExplainRequest {
  driver: string
  schema: Record<string, string[]>
  sql: string
}

export async function explainQuery(req: AiExplainRequest): Promise<string> {
  const { client, dialect: d } = makeClient()
  const dialect = d(req.driver)

  const system =
    `You are a senior database engineer. Explain what the given ${dialect} query does in clear, ` +
    `plain English for a developer. Cover the tables involved, joins, filters, grouping/ordering, ` +
    `and call out any obvious performance concerns (missing indexes, full scans, cartesian joins). ` +
    `Be concise — a few short paragraphs or bullet points. Do not restate the SQL verbatim.`

  const user = `Database schema:\n${schemaText(req.schema)}\n\nQuery:\n${req.sql}`

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system,
    messages: [{ role: 'user', content: user }]
  } as Anthropic.MessageCreateParamsNonStreaming)

  return textOf(response).trim()
}

export interface AiFixRequest {
  driver: string
  schema: Record<string, string[]>
  sql: string
  error: string
}

export async function fixQuery(req: AiFixRequest): Promise<AiSqlResult> {
  const { client, dialect: d } = makeClient()
  const dialect = d(req.driver)

  const system =
    `A ${dialect} query failed. Given the schema, the query, and the database error message, return a ` +
    `corrected query that resolves the error while preserving the original intent. Use only tables and ` +
    `columns from the schema. Respond with JSON: "sql" is the corrected query, "notes" is one short ` +
    `sentence explaining what you changed.`

  const user =
    `Database schema:\n${schemaText(req.schema)}\n\nFailing query:\n${req.sql}\n\nError:\n${req.error}`

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: SQL_SCHEMA } }
  } as Anthropic.MessageCreateParamsNonStreaming)

  return parseSql(textOf(response))
}
