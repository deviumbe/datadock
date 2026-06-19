import type { Redis } from 'ioredis'
import type { QueueFramework, QueueJob, QueueJobState, QueueOverview } from '@shared/types'

/**
 * Framework-agnostic Redis queue discovery.
 *
 * We can't know which library produced a queue, so we probe the keyspace with a
 * handful of targeted SCAN patterns and classify what we find. Recognized layouts
 * (Laravel/Horizon, BullMQ/Bull, Sidekiq, RQ, Celery) get framework-specific job
 * parsing; everything else falls back to a generic list/zset queue.
 *
 * The functions here are stateless: `discoverQueues` is re-run for both the
 * overview and any drill-down so the adapter never has to cache anything.
 */

/** How the entries for one queue-state are stored + how to read a job payload. */
type StateSource =
  | { container: 'list' | 'zset' | 'stream'; key: string; payload: 'inline' }
  | {
      container: 'list' | 'zset'
      key: string
      payload: 'hashId'
      hashKey: (id: string) => string
    }

interface DetectedQueue {
  name: string
  framework: QueueFramework
  states: Partial<Record<QueueJobState, StateSource>>
}

const STATES: QueueJobState[] = ['pending', 'delayed', 'reserved', 'failed', 'completed']

// ---- scanning ---------------------------------------------------------------

/** SCAN all keys matching `match` (capped to keep large keyspaces responsive). */
async function scan(client: Redis, match: string, cap = 5000): Promise<string[]> {
  const out: string[] = []
  const stream = client.scanStream({ match, count: 500 })
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (keys: string[]) => {
      for (const k of keys) {
        out.push(k)
        if (out.length >= cap) {
          stream.pause()
          stream.destroy()
          resolve()
          return
        }
      }
    })
    stream.on('end', () => resolve())
    stream.on('close', () => resolve())
    stream.on('error', reject)
  })
  return out
}

/** TYPE for many keys in one pipeline. */
async function typesOf(client: Redis, keys: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!keys.length) return map
  const pipe = client.pipeline()
  for (const k of keys) pipe.type(k)
  const res = await pipe.exec()
  res?.forEach(([, t], i) => map.set(keys[i], typeof t === 'string' ? t : 'none'))
  return map
}

async function count(client: Redis, src: StateSource | undefined): Promise<number> {
  if (!src) return 0
  try {
    if (src.container === 'list') return await client.llen(src.key)
    if (src.container === 'zset') return await client.zcard(src.key)
    if (src.container === 'stream') return await client.xlen(src.key)
  } catch {
    /* key vanished / wrong type */
  }
  return 0
}

// ---- detection --------------------------------------------------------------

export async function discoverQueues(client: Redis): Promise<DetectedQueue[]> {
  const byId = new Map<string, DetectedQueue>()
  const claimed = new Set<string>()
  const id = (q: DetectedQueue): string => `${q.framework}:${q.name}`
  const add = (q: DetectedQueue): void => {
    if (!byId.has(id(q))) byId.set(id(q), q)
  }

  // Gather candidate keys across the frameworks we understand, with their types.
  const patterns = [
    '*queues:*', // Laravel
    '*horizon:*', // Horizon
    '*:wait', '*:active', '*:delayed', '*:completed', '*:failed', '*:paused', // BullMQ
    'rq:*', // RQ
    '_kombu.binding.*', // Celery
    'queue:*', 'schedule', 'retry', 'dead', // Sidekiq
    '*queue*', '*job*', '*task*' // generic
  ]
  const keySet = new Set<string>()
  for (const p of patterns) for (const k of await scan(client, p)) keySet.add(k)
  const keys = [...keySet]
  const types = await typesOf(client, keys)
  const has = (k: string): boolean => types.has(k)
  const horizonPresent = keys.some((k) => /(^|:)horizon:/.test(k))

  // ---- Laravel / Horizon ----------------------------------------------------
  // Pending list at `…queues:{name}`, siblings `:delayed` / `:reserved` zsets.
  for (const k of keys) {
    const m = /(^.*queues:[^:]+)$/.exec(k)
    if (!m || types.get(k) !== 'list') continue
    const base = m[1]
    const name = base.replace(/^.*queues:/, '')
    const delayed = `${base}:delayed`
    const reserved = `${base}:reserved`
    const framework: QueueFramework = horizonPresent ? 'horizon' : 'laravel'
    const q: DetectedQueue = {
      name,
      framework,
      states: { pending: { container: 'list', key: base, payload: 'inline' } }
    }
    if (has(delayed)) q.states.delayed = { container: 'zset', key: delayed, payload: 'inline' }
    if (has(reserved)) q.states.reserved = { container: 'zset', key: reserved, payload: 'inline' }
    claimed.add(base).add(delayed).add(reserved)
    add(q)
  }
  // Horizon failed jobs: `…horizon:failed` zset of ids → hash `…horizon:{id}`.
  for (const k of keys) {
    if (!/horizon:failed$/.test(k) || types.get(k) !== 'zset') continue
    const hashBase = k.slice(0, -'failed'.length) // `…horizon:`
    const target = [...byId.values()].find((q) => q.framework === 'horizon')
    const src: StateSource = {
      container: 'zset',
      key: k,
      payload: 'hashId',
      hashKey: (jid) => `${hashBase}${jid}`
    }
    claimed.add(k)
    if (target) target.states.failed = src
    else add({ name: 'horizon', framework: 'horizon', states: { failed: src } })
  }

  // ---- BullMQ / Bull --------------------------------------------------------
  // `{prefix}:{name}:{wait|active|delayed|completed|failed}` ; jobs in hashes
  // `{prefix}:{name}:{id}`.
  const bullSuffix: Record<string, QueueJobState> = {
    wait: 'pending',
    active: 'reserved',
    delayed: 'delayed',
    completed: 'completed',
    failed: 'failed'
  }
  for (const k of keys) {
    if (claimed.has(k)) continue // don't re-claim Laravel's :delayed/:reserved zsets
    const m = /^(.*):([^:]+):(wait|active|delayed|completed|failed)$/.exec(k)
    if (!m) continue
    const [, prefix, name, suffix] = m
    const t = types.get(k)
    if (suffix === 'wait' || suffix === 'active') {
      if (t !== 'list') continue
    } else if (t !== 'zset') continue
    const base = `${prefix}:${name}`
    const q = byId.get(`bullmq:${name}`) ?? { name, framework: 'bullmq' as const, states: {} }
    const state = bullSuffix[suffix]
    q.states[state] = {
      container: suffix === 'wait' || suffix === 'active' ? 'list' : 'zset',
      key: k,
      payload: 'hashId',
      hashKey: (jid) => `${base}:${jid}`
    }
    claimed.add(k)
    add(q)
  }

  // ---- Sidekiq --------------------------------------------------------------
  // Per-queue `queue:{name}` lists hold JSON jobs; global `schedule`/`retry`/`dead`
  // zsets are surfaced as their own pseudo-queues so counts stay honest.
  for (const k of keys) {
    const m = /^queue:([^:]+)$/.exec(k)
    if (!m || types.get(k) !== 'list') continue
    claimed.add(k)
    add({
      name: m[1],
      framework: 'sidekiq',
      states: { pending: { container: 'list', key: k, payload: 'inline' } }
    })
  }
  const sidekiqGlobals: [string, QueueJobState][] = [
    ['schedule', 'delayed'],
    ['retry', 'reserved'],
    ['dead', 'failed']
  ]
  for (const [key, state] of sidekiqGlobals) {
    if (types.get(key) !== 'zset') continue
    claimed.add(key)
    add({
      name: `(${key})`,
      framework: 'sidekiq',
      states: { [state]: { container: 'zset', key, payload: 'inline' } }
    })
  }

  // ---- Python RQ ------------------------------------------------------------
  // `rq:queue:{name}` list of job ids → hash `rq:job:{id}`.
  for (const k of keys) {
    const m = /^(.*)rq:queue:([^:]+)$/.exec(k)
    if (!m || types.get(k) !== 'list') continue
    const [, pfx, name] = m
    claimed.add(k)
    add({
      name,
      framework: 'rq',
      states: {
        pending: {
          container: 'list',
          key: k,
          payload: 'hashId',
          hashKey: (jid) => `${pfx}rq:job:${jid}`
        }
      }
    })
  }

  // ---- Celery ---------------------------------------------------------------
  // `_kombu.binding.{name}` set marks a queue; the queue itself is a list `{name}`.
  for (const k of keys) {
    const m = /^_kombu\.binding\.(.+)$/.exec(k)
    if (!m) continue
    const name = m[1]
    if (types.get(name) !== 'list') continue
    claimed.add(name)
    add({
      name,
      framework: 'celery',
      states: { pending: { container: 'list', key: name, payload: 'inline' } }
    })
  }

  // ---- Generic fallback -----------------------------------------------------
  // Any leftover list/zset whose name reads like a queue.
  for (const k of keys) {
    if (claimed.has(k)) continue
    const t = types.get(k)
    if (t !== 'list' && t !== 'zset') continue
    if (!/(queue|jobs?|tasks?)/i.test(k)) continue
    add({
      name: k,
      framework: 'generic',
      states: {
        [t === 'list' ? 'pending' : 'delayed']: { container: t, key: k, payload: 'inline' }
      }
    })
  }

  return [...byId.values()]
}

// ---- overview / counts ------------------------------------------------------

export async function queueOverview(client: Redis, q: DetectedQueue): Promise<QueueOverview> {
  const [pending, delayed, reserved, failed, completed] = await Promise.all([
    count(client, q.states.pending),
    count(client, q.states.delayed),
    count(client, q.states.reserved),
    count(client, q.states.failed),
    count(client, q.states.completed)
  ])
  const keys = STATES.map((s) => q.states[s]?.key).filter((k): k is string => !!k)
  return {
    name: q.name,
    framework: q.framework,
    pending,
    delayed,
    reserved,
    failed,
    completed: q.states.completed ? completed : undefined,
    keys
  }
}

// ---- job fetching -----------------------------------------------------------

/** Read the raw stored entries (payloads or ids) for one state, paged. */
async function readEntries(
  client: Redis,
  src: StateSource,
  offset: number,
  limit: number
): Promise<string[]> {
  const stop = offset + limit - 1
  if (src.container === 'list') return client.lrange(src.key, offset, stop)
  if (src.container === 'zset') return client.zrange(src.key, offset, stop)
  return []
}

export async function queueJobs(
  client: Redis,
  q: DetectedQueue,
  state: QueueJobState,
  offset: number,
  limit: number
): Promise<QueueJob[]> {
  const src = q.states[state]
  if (!src) return []
  const entries = await readEntries(client, src, offset, limit)

  // For id-backed states, resolve each id to its hash and serialize it.
  if (src.payload === 'hashId') {
    const out: QueueJob[] = []
    for (const jid of entries) {
      const hash = await client.hgetall(src.hashKey(jid)).catch(() => ({}) as Record<string, string>)
      out.push(parseHashJob(q.framework, state, jid, hash))
    }
    return out
  }

  return entries.map((raw) => parseInlineJob(q.framework, state, raw))
}

/** Find a queue by name+framework, then DEL the entry / purge the state key. */
export async function queueAction(
  client: Redis,
  q: DetectedQueue,
  state: QueueJobState,
  action: 'retry' | 'delete' | 'purge',
  jobId?: string
): Promise<void> {
  const src = q.states[state]
  if (!src) return
  if (action === 'purge') {
    await client.del(src.key)
    return
  }
  if (jobId == null) return
  // `jobId` is the raw member (inline payload) or the id (hash-backed).
  if (src.container === 'list') await client.lrem(src.key, 0, jobId)
  else if (src.container === 'zset') await client.zrem(src.key, jobId)
  // 'retry' currently behaves like a remove from the failed list; re-enqueue
  // semantics vary too much per framework to do safely here.
}

// ---- payload parsing --------------------------------------------------------

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function parseInlineJob(
  framework: QueueFramework,
  state: QueueJobState,
  raw: string
): QueueJob {
  const payload = tryJson(raw)
  const p = (payload ?? {}) as Record<string, unknown>
  // Pull a human name from the various known shapes.
  const data = (p.data ?? {}) as Record<string, unknown>
  const headers = (p.headers ?? {}) as Record<string, unknown>
  const name =
    (p.displayName as string) ||
    (data.commandName as string) ||
    (p.class as string) || // Sidekiq
    (headers.task as string) || // Celery
    (p.job as string) ||
    (p.name as string) ||
    undefined
  return {
    id: (p.uuid as string) || (p.jid as string) || (p.id as string) || undefined,
    state,
    framework,
    name,
    attempts:
      (p.attempts as number) ?? (p.retry_count as number) ?? (p.retryCount as number) ?? undefined,
    queue: (p.queue as string) || undefined,
    payload: payload ?? raw,
    raw,
    member: raw
  }
}

function parseHashJob(
  framework: QueueFramework,
  state: QueueJobState,
  id: string,
  hash: Record<string, string>
): QueueJob {
  // BullMQ stores `data`/`opts`/`name`/`attemptsMade`/`failedReason`; RQ stores
  // `description`/`status`/`exc_info`; Horizon stores `name`/`payload`/`exception`.
  const dataRaw = hash.data ?? hash.payload ?? ''
  const payload = dataRaw ? (tryJson(dataRaw) ?? dataRaw) : hash
  const inner = (typeof payload === 'object' && payload ? payload : {}) as Record<string, unknown>
  return {
    id,
    state,
    framework,
    name: hash.name || hash.description || (inner.displayName as string) || undefined,
    attempts: hash.attemptsMade ? Number(hash.attemptsMade) : undefined,
    queue: hash.queue || undefined,
    at: hash.failed_at || hash.timestamp || undefined,
    payload,
    raw: JSON.stringify(hash),
    member: id,
    exception: hash.failedReason || hash.exception || hash.exc_info || undefined
  }
}
