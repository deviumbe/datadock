// Native database cloning via the engine's own dump/restore CLIs (mysqldump|mysql,
// pg_dump|psql). The data streams entirely through native processes and a temp
// file on disk — never through the V8 heap — so large clones can't OOM, and the
// tools handle escaping, charset and FK ordering correctly on their own.
import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, createReadStream } from 'fs'
import { writeFile, unlink, stat, access } from 'fs/promises'
import { constants } from 'fs'
import { tmpdir } from 'os'
import { join, delimiter } from 'path'
import type { ConnectionConfig, IoProgress, SqlDialect } from '@shared/types'
import { sqlDialect } from '@shared/types'

type ProgressFn = (p: Omit<IoProgress, 'opId'>) => void

// Live native child processes per op id, so a cancel can kill them directly
// (belt-and-suspenders alongside the AbortSignal).
const liveChildren = new Map<string, Set<ChildProcess>>()
function track(opId: string | undefined, child: ChildProcess): () => void {
  if (!opId) return () => undefined
  const set = liveChildren.get(opId) ?? new Set<ChildProcess>()
  liveChildren.set(opId, set)
  set.add(child)
  return () => {
    set.delete(child)
    if (set.size === 0) liveChildren.delete(opId)
  }
}

/** Kill any native dump/restore processes for an op id. Returns true if any were killed. */
export function killNativeChildren(opId: string): boolean {
  const set = liveChildren.get(opId)
  if (!set || set.size === 0) return false
  for (const c of set) c.kill('SIGKILL')
  return true
}

export interface CloneTools {
  dump: string
  restore: string
}

export interface CloneSpec {
  /** Tables to clone (used when not the whole database). */
  includeTables: string[]
  /** True when every table is included — dump the whole database. */
  allIncluded: boolean
  mode: 'replace' | 'merge'
  structureOnly: boolean
  dataOnly: boolean
}

// Dirs where DB CLIs commonly live but a GUI app's PATH may miss (macOS apps
// launched from Finder get a minimal PATH).
const EXTRA_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/Applications/Postgres.app/Contents/Versions/latest/bin'
]

async function findBinary(name: string): Promise<string | null> {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const dirs = [...(process.env.PATH?.split(delimiter) ?? []), ...EXTRA_DIRS]
  for (const dir of dirs) {
    if (!dir) continue
    const p = join(dir, exe)
    try {
      await access(p, constants.X_OK)
      return p
    } catch {
      /* not here */
    }
  }
  return null
}

/** Locate the dump/restore CLIs for a dialect, or null if unavailable/unsupported. */
export async function findCloneTools(dialect: SqlDialect): Promise<CloneTools | null> {
  const pair = dialect === 'mysql' ? ['mysqldump', 'mysql'] : dialect === 'postgres' ? ['pg_dump', 'psql'] : null
  if (!pair) return null
  const [dump, restore] = await Promise.all([findBinary(pair[0]), findBinary(pair[1])])
  return dump && restore ? { dump, restore } : null
}

const host = (c: ConnectionConfig): string => c.host || '127.0.0.1'
const port = (c: ConnectionConfig): string =>
  String(c.port || (sqlDialect(c.driver) === 'mysql' ? 3306 : 5432))

/** Write a 0600 my.cnf so the password never appears in argv or env. */
async function writeMyCnf(cfg: ConnectionConfig): Promise<string> {
  const p = join(tmpdir(), `datadock-${Date.now()}-${Math.round(Math.random() * 1e9)}.cnf`)
  const lines = ['[client]', `user=${cfg.user ?? ''}`]
  if (cfg.password) {
    const esc = cfg.password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    lines.push(`password="${esc}"`)
  }
  await writeFile(p, lines.join('\n') + '\n', { mode: 0o600 })
  return p
}

interface SpawnOpts {
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  opId?: string
}

/** Run the dump CLI, streaming stdout to `outFile`; reports bytes written. */
function runDump(o: SpawnOpts & { outFile: string; tool: string; onProgress?: ProgressFn }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(o.bin, o.args, { env: o.env })
    const untrack = track(o.opId, child)
    const out = createWriteStream(o.outFile)
    let bytes = 0
    let lastEmit = 0
    let stderr = ''
    const onAbort = (): void => void child.kill('SIGKILL')
    o.signal?.addEventListener('abort', onAbort)
    if (o.signal?.aborted) child.kill('SIGKILL')

    o.onProgress?.({ phase: 'dump', label: `Dumping source with ${o.tool}…`, current: 0, total: 0 })
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      const now = Date.now()
      if (o.onProgress && now - lastEmit > 400) {
        lastEmit = now
        o.onProgress({
          phase: 'dump',
          label: `Dumping source with ${o.tool} — ${(bytes / 1048576).toFixed(0)} MB`,
          current: 0,
          total: 0
        })
      }
    })
    child.stdout.pipe(out)
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    child.on('error', (e) => {
      untrack()
      o.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      untrack()
      o.signal?.removeEventListener('abort', onAbort)
      out.end(() => {
        if (o.signal?.aborted) reject(new Error('Canceled'))
        else if (code === 0) resolve()
        else reject(new Error(`${o.tool} failed (exit ${code}): ${stderr.trim().slice(0, 600)}`))
      })
    })
  })
}

/** Run the restore CLI, streaming `inFile` to stdin; reports bytes consumed. */
async function runRestore(
  o: SpawnOpts & { inFile: string; label: string; onProgress?: ProgressFn }
): Promise<void> {
  const { size } = await stat(o.inFile)
  return new Promise<void>((resolve, reject) => {
    const child = spawn(o.bin, o.args, { env: o.env })
    const untrack = track(o.opId, child)
    const input = createReadStream(o.inFile)
    let bytes = 0
    let lastEmit = 0
    let stderr = ''
    const onAbort = (): void => void child.kill('SIGKILL')
    o.signal?.addEventListener('abort', onAbort)
    if (o.signal?.aborted) child.kill('SIGKILL')

    input.on('data', (chunk: Buffer | string) => {
      bytes += chunk.length
      const now = Date.now()
      if (o.onProgress && now - lastEmit > 200) {
        lastEmit = now
        o.onProgress({ phase: 'import', label: o.label, current: bytes, total: size })
      }
    })
    // Feeding the file is far faster than executing it: once it's all piped, the
    // client is still applying statements (e.g. inserting/rebuilding indexes on
    // the last big table). Show a ticking "applying" timer instead of a frozen
    // 100% so it's visibly alive (and so the user knows they can cancel/wait).
    let applyTimer: ReturnType<typeof setInterval> | undefined
    input.on('end', () => {
      const started = Date.now()
      const tick = (): void => {
        const s = Math.round((Date.now() - started) / 1000)
        const t = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
        o.onProgress?.({ phase: 'import', label: `${o.label} — applying… (${t})`, current: 0, total: 0 })
      }
      tick()
      applyTimer = setInterval(tick, 1000)
    })
    input.on('error', reject)
    child.stdin.on('error', () => {
      /* child may exit early; its close handler reports the real error */
    })
    input.pipe(child.stdin)
    // Drain stdout so a chatty client (psql prints a tag per statement) can't
    // block on a full pipe and deadlock.
    child.stdout.on('data', () => {})
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    const finish = (): void => {
      if (applyTimer) clearInterval(applyTimer)
      untrack()
      o.signal?.removeEventListener('abort', onAbort)
    }
    child.on('error', (e) => {
      finish()
      reject(e)
    })
    child.on('close', (code) => {
      finish()
      if (o.signal?.aborted) reject(new Error('Canceled'))
      else if (code === 0) resolve()
      else reject(new Error(`Restore failed (exit ${code}): ${stderr.trim().slice(0, 600)}`))
    })
  })
}

interface DumpInvocation {
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv
  tool: string
  /** Temp files (e.g. a my.cnf) to delete once the dump is done. */
  cleanup: string[]
}

/** Assemble the dump CLI invocation for a source + spec (shared by export & clone). */
async function buildDump(tools: CloneTools, source: ConnectionConfig, spec: CloneSpec): Promise<DumpInvocation> {
  if (sqlDialect(source.driver) === 'mysql') {
    const cnf = await writeMyCnf(source)
    const args = [
      `--defaults-extra-file=${cnf}`,
      '-h',
      host(source),
      '-P',
      port(source),
      '--single-transaction',
      '--quick',
      '--no-tablespaces'
    ]
    if (source.ssl) args.push('--ssl-mode=REQUIRED')
    if (spec.mode === 'merge') args.push('--skip-add-drop-table')
    if (spec.structureOnly) args.push('--no-data')
    if (spec.dataOnly) args.push('--no-create-info')
    args.push(source.database ?? '')
    if (!spec.allIncluded) args.push(...spec.includeTables)
    return { bin: tools.dump, args, env: process.env, tool: 'mysqldump', cleanup: [cnf] }
  }
  // postgres family
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: source.password ?? '' }
  if (source.ssl) env.PGSSLMODE = 'require'
  const args = ['-h', host(source), '-p', port(source), '-U', source.user ?? '', '--no-owner', '--no-privileges']
  if (spec.mode === 'replace') args.push('--clean', '--if-exists')
  if (spec.structureOnly) args.push('--schema-only')
  if (spec.dataOnly) args.push('--data-only')
  if (!spec.allIncluded) for (const t of spec.includeTables) args.push('-t', t)
  args.push(source.database ?? '')
  return { bin: tools.dump, args, env, tool: 'pg_dump', cleanup: [] }
}

/** Dump a database to `outFile` using its native CLI (used by Export Database). */
export async function nativeDump(
  tools: CloneTools,
  source: ConnectionConfig,
  spec: CloneSpec,
  outFile: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
  opId?: string
): Promise<void> {
  const inv = await buildDump(tools, source, spec)
  try {
    await runDump({ bin: inv.bin, args: inv.args, env: inv.env, outFile, tool: inv.tool, onProgress, signal, opId })
  } finally {
    for (const f of inv.cleanup) await unlink(f).catch(() => undefined)
  }
}

/**
 * Clone `source` into `target` using native CLIs. Both configs must be the
 * fully-resolved (decrypted, tunnel-rewritten) configs the adapters hold.
 */
export async function nativeClone(
  tools: CloneTools,
  source: ConnectionConfig,
  target: ConnectionConfig,
  spec: CloneSpec,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
  opId?: string
): Promise<void> {
  const tmpFile = join(tmpdir(), `datadock-clone-${Date.now()}.sql`)
  const cleanup: string[] = [tmpFile]
  try {
    await nativeDump(tools, source, spec, tmpFile, onProgress, signal, opId)

    if (sqlDialect(target.driver) === 'mysql') {
      const cnf = await writeMyCnf(target)
      cleanup.push(cnf)
      const args = [`--defaults-extra-file=${cnf}`, '-h', host(target), '-P', port(target)]
      if (target.ssl) args.push('--ssl-mode=REQUIRED')
      if (spec.mode === 'merge') args.push('--force')
      args.push(target.database ?? '')
      await runRestore({ bin: tools.restore, args, env: process.env, inFile: tmpFile, label: `Restoring into ${target.name}`, onProgress, signal, opId })
    } else {
      const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: target.password ?? '' }
      if (target.ssl) env.PGSSLMODE = 'require'
      const args = ['-h', host(target), '-p', port(target), '-U', target.user ?? '', '-d', target.database ?? '', '-v', 'ON_ERROR_STOP=0']
      await runRestore({ bin: tools.restore, args, env, inFile: tmpFile, label: `Restoring into ${target.name}`, onProgress, signal, opId })
    }
  } finally {
    for (const f of cleanup) await unlink(f).catch(() => undefined)
  }
}
