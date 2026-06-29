import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { AiProvider, ChatStep } from '@shared/types'
import { resolveProvider, type ResolvedProvider, PROVIDER_META } from './settings'

// A thin abstraction over the supported AI providers. Anthropic uses its own
// SDK; Google (Gemini), Mistral, xAI (Grok) and Ollama are all reached through
// their OpenAI-compatible chat endpoints via the `openai` client with a custom
// baseURL. This keeps a single code path for everything except Anthropic.

const OPENAI_BASE: Record<Exclude<AiProvider, 'anthropic' | 'ollama'>, string> = {
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1'
}

function ensureReady(rp: ResolvedProvider): void {
  if (PROVIDER_META[rp.provider].needsKey && !rp.apiKey) {
    throw new Error(`No API key set for ${PROVIDER_META[rp.provider].label}. Add one in Settings → AI.`)
  }
}

function openaiClient(rp: ResolvedProvider): OpenAI {
  const baseURL =
    rp.provider === 'ollama'
      ? `${(rp.baseUrl || 'http://localhost:11434').replace(/\/+$/, '')}/v1`
      : OPENAI_BASE[rp.provider as Exclude<AiProvider, 'anthropic' | 'ollama'>]
  // Ollama ignores the key but the client requires a non-empty string.
  return new OpenAI({ apiKey: rp.apiKey || 'ollama', baseURL })
}

function anthropicText(res: Anthropic.Message): string {
  if (res.stop_reason === 'refusal') {
    throw new Error('The request was declined by the model. Try rephrasing.')
  }
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** Single-shot completion using the active provider. */
export async function complete(opts: { system: string; user: string }): Promise<string> {
  const rp = resolveProvider()
  ensureReady(rp)
  if (rp.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: rp.apiKey! })
    const res = await client.messages.create({
      model: rp.model,
      max_tokens: 2048,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }]
    })
    return anthropicText(res)
  }
  const client = openaiClient(rp)
  const res = await client.chat.completions.create({
    model: rp.model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user }
    ]
  })
  return (res.choices[0]?.message?.content ?? '').trim()
}

/** A read-only query runner the assistant can call; returns formatted rows. */
export type RunSql = (sql: string) => Promise<{ text: string; rowCount: number }>

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}
export interface ChatResult {
  answer: string
  steps: ChatStep[]
}

const TOOL_NAME = 'run_sql'
const TOOL_DESC =
  'Run a single READ-ONLY SQL query (SELECT / WITH / EXPLAIN / SHOW only) against the ' +
  'connected database and get the rows back as text. Use this to inspect the actual data ' +
  'before answering. Never attempt to modify data.'
const MAX_STEPS = 6

/**
 * Run an agentic conversation where the model may call `run_sql` (read-only) to
 * inspect the live database before answering the user's question.
 */
export async function chatWithData(opts: {
  system: string
  history: ChatTurn[]
  runSql: RunSql
  /** Called with text deltas as the model streams its answer (Anthropic). */
  onDelta?: (text: string) => void
}): Promise<ChatResult> {
  const rp = resolveProvider()
  ensureReady(rp)
  const steps: ChatStep[] = []
  return rp.provider === 'anthropic'
    ? anthropicChat(rp, opts, steps)
    : openaiChat(rp, opts, steps)
}

async function anthropicChat(
  rp: ResolvedProvider,
  opts: { system: string; history: ChatTurn[]; runSql: RunSql; onDelta?: (t: string) => void },
  steps: ChatStep[]
): Promise<ChatResult> {
  const client = new Anthropic({ apiKey: rp.apiKey! })
  const tools: Anthropic.Tool[] = [
    {
      name: TOOL_NAME,
      description: TOOL_DESC,
      input_schema: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'A single read-only SQL query' } },
        required: ['sql']
      }
    }
  ]
  const messages: Anthropic.MessageParam[] = opts.history.map((m) => ({
    role: m.role,
    content: m.content
  }))

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = client.messages.stream({
      model: rp.model,
      max_tokens: 2048,
      system: opts.system,
      tools,
      messages
    })
    if (opts.onDelta) stream.on('text', (t) => opts.onDelta!(t))
    const res = await stream.finalMessage()
    if (res.stop_reason !== 'tool_use') return { answer: anthropicText(res), steps }

    messages.push({ role: 'assistant', content: res.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const block of res.content) {
      if (block.type !== 'tool_use' || block.name !== TOOL_NAME) continue
      const sql = String((block.input as { sql?: string }).sql ?? '')
      try {
        const out = await opts.runSql(sql)
        steps.push({ sql, rowCount: out.rowCount })
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out.text })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        steps.push({ sql, error: msg })
        results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${msg}`, is_error: true })
      }
    }
    messages.push({ role: 'user', content: results })
  }

  // Out of tool budget — force a final textual answer.
  const stream = client.messages.stream({
    model: rp.model,
    max_tokens: 2048,
    system: opts.system,
    messages
  })
  if (opts.onDelta) stream.on('text', (t) => opts.onDelta!(t))
  return { answer: anthropicText(await stream.finalMessage()), steps }
}

async function openaiChat(
  rp: ResolvedProvider,
  opts: { system: string; history: ChatTurn[]; runSql: RunSql },
  steps: ChatStep[]
): Promise<ChatResult> {
  const client = openaiClient(rp)
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description: TOOL_DESC,
        parameters: {
          type: 'object',
          properties: { sql: { type: 'string', description: 'A single read-only SQL query' } },
          required: ['sql']
        }
      }
    }
  ]
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: opts.system },
    ...opts.history.map((m) => ({ role: m.role, content: m.content }))
  ]

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.chat.completions.create({ model: rp.model, messages, tools })
    const msg = res.choices[0]?.message
    if (!msg?.tool_calls?.length) return { answer: (msg?.content ?? '').trim(), steps }

    messages.push(msg)
    for (const tc of msg.tool_calls) {
      if (tc.type !== 'function') continue
      let sql = ''
      try {
        sql = String((JSON.parse(tc.function.arguments || '{}') as { sql?: string }).sql ?? '')
        const out = await opts.runSql(sql)
        steps.push({ sql, rowCount: out.rowCount })
        messages.push({ role: 'tool', tool_call_id: tc.id, content: out.text })
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        steps.push({ sql, error: m })
        messages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${m}` })
      }
    }
  }

  const final = await client.chat.completions.create({ model: rp.model, messages })
  return { answer: (final.choices[0]?.message?.content ?? '').trim(), steps }
}

/** Lightweight connectivity check used by the Settings "Test" button. */
export async function testProvider(provider: AiProvider): Promise<void> {
  const rp = resolveProvider(provider)
  ensureReady(rp)
  if (rp.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: rp.apiKey! })
    await client.messages.create({
      model: rp.model,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }]
    })
    return
  }
  const client = openaiClient(rp)
  await client.chat.completions.create({
    model: rp.model,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'ping' }]
  })
}
