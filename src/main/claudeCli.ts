import { spawn, execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { ChatStep } from '@shared/types'
import type { ChatResult, ChatTurn, RunSql } from './aiProviders'

// "Claude Code" provider: drives the locally installed `claude` CLI in headless
// print mode so AI features run on the user's Claude subscription instead of an
// API key. Every call is a fresh, tool-less process (`--tools ""`, no MCP, no
// session persistence) — the model can only return text; DataDock itself runs
// any SQL it asks for through the same read-only runner the other providers use.

const TIMEOUT_MS = 5 * 60_000
const MAX_STEPS = 6

let cachedBin: string | undefined

/** Ask the user's login shell where `claude` lives (GUI apps get a minimal PATH). */
function shellLookup(): Promise<string | undefined> {
  if (process.platform === 'win32') {
    return new Promise((resolve) =>
      execFile('where', ['claude'], (err, out) => resolve(err ? undefined : out.split(/\r?\n/)[0]?.trim() || undefined))
    )
  }
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) =>
    execFile(shell, ['-lic', 'command -v claude'], { timeout: 10_000 }, (err, out) => {
      const line = out
        ?.split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('/'))
      resolve(err && !line ? undefined : line)
    })
  )
}

/** Resolve the CLI binary: explicit path from Settings, known install spots, then the login shell. */
async function resolveBin(configured?: string): Promise<string> {
  if (configured?.trim()) return configured.trim().replace(/^~(?=$|[\\/])/, homedir())
  if (cachedBin) return cachedBin
  const home = homedir()
  const candidates =
    process.platform === 'win32'
      ? [join(home, '.local', 'bin', 'claude.exe')]
      : [
          join(home, '.local', 'bin', 'claude'),
          join(home, '.claude', 'local', 'claude'),
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude'
        ]
  const found = candidates.find((c) => existsSync(c)) ?? (await shellLookup())
  if (!found) {
    throw new Error(
      'Claude Code CLI not found. Install it (https://claude.com/claude-code) and run `claude` once to log in, ' +
        'or set the CLI path in Settings → AI.'
    )
  }
  cachedBin = found
  return found
}

interface RunOpts {
  bin?: string
  model: string
  system: string
  prompt: string
  /** Receives streamed text deltas. */
  onText?: (t: string) => void
}

/** Run one headless `claude -p` turn and return the final text. */
async function runCli(opts: RunOpts): Promise<string> {
  const bin = await resolveBin(opts.bin)
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--system-prompt',
    opts.system
  ]
  if (opts.model.trim()) args.push('--model', opts.model.trim())

  // Drop API-key env vars so the CLI authenticates with the subscription login
  // rather than silently billing an API key that happens to be in the env.
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    let stderr = ''
    let result: { text: string; isError: boolean } | undefined
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Claude Code CLI timed out.'))
    }, TIMEOUT_MS)

    const handleLine = (line: string): void => {
      if (!line.trim()) return
      let ev: {
        type?: string
        event?: { type?: string; delta?: { type?: string; text?: string } }
        result?: string
        is_error?: boolean
      }
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        opts.onText?.(ev.event.delta.text ?? '')
      } else if (ev.type === 'result') {
        result = { text: ev.result ?? '', isError: !!ev.is_error }
      }
    }

    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    })
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (c: string) => (stderr += c))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`Could not start Claude Code CLI (${bin}): ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      handleLine(buf)
      if (result && !result.isError) return resolve(result.text.trim())
      const detail = (result?.text || stderr || `exited with code ${code}`).trim()
      reject(new Error(`Claude Code CLI: ${detail.slice(0, 500)}`))
    })
    child.stdin.end(opts.prompt)
  })
}

/** Single-shot completion. */
export function cliComplete(opts: { bin?: string; model: string; system: string; user: string }): Promise<string> {
  return runCli({ bin: opts.bin, model: opts.model, system: opts.system, prompt: opts.user })
}

// ---- chat with data ---------------------------------------------------------
// The CLI runs with no tools, so `run_sql` is a text protocol: the model replies
// with only a ```run_sql fenced block, DataDock runs it read-only and feeds the
// rows back on the next turn. Each turn re-sends the transcript (stateless CLI).

const FENCE = '```run_sql'
const PROTOCOL = `

## Running queries
You can inspect the live database. To run a query, reply with ONLY a fenced block and nothing else:
${FENCE}
SELECT ...
\`\`\`
Use a single READ-ONLY statement (SELECT / WITH / EXPLAIN / SHOW). DataDock runs it and sends you the result in the next message.
Never describe a query for the user to run themselves — request it with a run_sql block and wait for the result.
Run at most one query per reply. When you have enough information, reply with your final answer for the user (no run_sql block).`

// Models often add a sentence before the block ("Let me check…"), so match it
// anywhere in the reply rather than requiring the reply to be only the block.
const RUN_RE = /```run_sql[^\S\n]*\n([\s\S]*?)```/

function transcript(history: ChatTurn[], toolLog: string[]): string {
  const parts = history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`)
  return [...parts, ...toolLog].join('\n\n')
}

export async function cliChatWithData(opts: {
  bin?: string
  model: string
  system: string
  history: ChatTurn[]
  runSql: RunSql
  onDelta?: (text: string) => void
}): Promise<ChatResult> {
  const steps: ChatStep[] = []
  const toolLog: string[] = []
  const system = opts.system + PROTOCOL

  for (let step = 0; step <= MAX_STEPS; step++) {
    const last = step === MAX_STEPS
    // Stream text live, but hold back anything that could be the start of a
    // run_sql fence and stop forwarding once one appears — query requests are
    // never shown. The renderer swaps the preview for the final answer anyway.
    let all = ''
    let sent = 0
    let fenced = false
    if (step > 0) opts.onDelta?.('\n\n')
    const onText = (t: string): void => {
      if (!opts.onDelta || fenced) return
      all += t
      const at = all.indexOf(FENCE)
      if (at >= 0) fenced = true
      const upTo = at >= 0 ? at : Math.max(sent, all.length - FENCE.length + 1)
      if (upTo > sent) {
        opts.onDelta(all.slice(sent, upTo))
        sent = upTo
      }
    }
    const prompt =
      transcript(opts.history, toolLog) +
      (last ? '\n\n(Query budget exhausted — answer the user now with what you have, without run_sql.)' : '')
    const text = await runCli({ bin: opts.bin, model: opts.model, system, prompt, onText })

    const m = RUN_RE.exec(text)
    // Out of budget: drop any stray query block rather than show it as the answer.
    if (!m || last) return { answer: text.replace(RUN_RE, '').trim() || text, steps }

    const sql = m[1].trim()
    try {
      const out = await opts.runSql(sql)
      steps.push({ sql, rowCount: out.rowCount })
      toolLog.push(`Assistant:\n${text}`, `DataDock (query result):\n${out.text}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      steps.push({ sql, error: msg })
      toolLog.push(`Assistant:\n${text}`, `DataDock (query error):\n${msg}`)
    }
  }
  throw new Error('unreachable')
}

/**
 * Models offered for the CLI. The CLI has no headless "list models" command, so
 * this is the aliases (which it resolves to the latest version of each family)
 * plus pinned full ids. `--model` accepts any full id, so the field stays free-text.
 */
export const CLI_MODELS = [
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5'
]
