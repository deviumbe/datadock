import type {
  InvestigationReport,
  InvestigationType,
  QueryResult
} from '@shared/types'
import { PG_FAMILY } from '@shared/types'
import { getAdapter } from './db'
import type { DbAdapter } from './db/types'
import { complete } from './aiProviders'
import { listHistory } from './history'
import { listSizes } from './sizeHistory'
import { listDashboards, listCharts, listDatasets } from './analytics'
import { buildChartSql } from './analyticsQuery'

/**
 * The AI Investigation Suite. Unlike the chat assistant, an investigation first
 * gathers **read-only evidence** from the live database (execution plans, index
 * catalogs, table statistics, locks, running queries, schema) using engine-
 * specific probes, then asks the configured AI provider to synthesize that
 * evidence into a structured, severity-ranked report. Nothing is ever mutated.
 *
 * Each investigation type is just a different evidence-gatherer + prompt; adding
 * the remaining suite features (data-quality, relationship discovery, security
 * audit, root-cause, …) means registering another gatherer here.
 */

interface Evidence {
  label: string
  text: string
}

/** Which rich probe set an engine gets. SQLite/MSSQL/Oracle/etc. → 'generic'. */
function dialectOf(driver: string): 'postgres' | 'mysql' | 'generic' {
  if ((PG_FAMILY as string[]).includes(driver)) return 'postgres'
  if (driver === 'mysql') return 'mysql'
  return 'generic'
}

/** Render a QueryResult as a compact text table for the evidence prompt. */
function asText(res: QueryResult, maxRows = 25): string {
  if (!res.columns.length) return '(no columns)'
  const head = res.columns.map((c) => c.name).join(' | ')
  const rows = res.rows.slice(0, maxRows).map((r) =>
    r.map((v) => (v === null || v === undefined ? 'NULL' : String(v))).join(' | ')
  )
  const more = res.rows.length > maxRows ? `\n… (${res.rows.length - maxRows} more rows)` : ''
  return [head, '-'.repeat(Math.min(head.length, 80)), ...rows].join('\n') + more
}

/** Safe to run EXPLAIN ANALYZE on (it executes the statement). CTEs excluded — they can hide DML. */
function isAnalyzeSafe(sql: string): boolean {
  return /^\s*(select|table|values)\b/i.test(sql)
}

/** Crudely extract referenced table names from a SQL statement to scope probes. */
function tablesInQuery(sql: string): string[] {
  const out = new Set<string>()
  const re = /(?:from|join)\s+["`]?([a-z_][\w]*)["`]?(?:\.["`]?([a-z_][\w]*)["`]?)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) out.add((m[2] ?? m[1]).toLowerCase())
  return [...out]
}

type Probe = (sql: string) => Promise<QueryResult>

/** Run a probe, returning evidence or noting why it was unavailable. */
async function probe(label: string, run: () => Promise<QueryResult>): Promise<Evidence | null> {
  try {
    const res = await run()
    if (!res.rows.length && !res.columns.length) return null
    return { label, text: asText(res) }
  } catch (e) {
    return { label, text: `(unavailable: ${e instanceof Error ? e.message : String(e)})` }
  }
}

// ---- evidence gatherers -----------------------------------------------------

async function queryEvidence(query: Probe, sql: string, dialect: string): Promise<Evidence[]> {
  const ev: (Evidence | null)[] = []
  const tables = tablesInQuery(sql)
  const tlist = tables.map((t) => `'${t}'`).join(', ') || `''`

  if (dialect === 'postgres') {
    ev.push(await probe('Plan (EXPLAIN)', () => query(`EXPLAIN (VERBOSE, COSTS) ${sql}`)))
    if (isAnalyzeSafe(sql))
      ev.push(await probe('Plan with actuals (EXPLAIN ANALYZE)', () =>
        query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, TIMING) ${sql}`)
      ))
    if (tables.length) {
      ev.push(await probe('Indexes on referenced tables', () =>
        query(`select tablename, indexname, indexdef from pg_indexes where tablename in (${tlist}) order by tablename`)
      ))
      ev.push(await probe('Table size & row estimates', () =>
        query(
          `select relname as table, n_live_tup as est_rows,
                  pg_size_pretty(pg_total_relation_size(relid)) as total_size
             from pg_stat_user_tables where relname in (${tlist}) order by n_live_tup desc`
        )
      ))
      ev.push(await probe('Statistics freshness', () =>
        query(
          `select relname as table, last_analyze, last_autoanalyze,
                  n_mod_since_analyze as mods_since_analyze, n_live_tup as live_rows
             from pg_stat_user_tables where relname in (${tlist})`
        )
      ))
      ev.push(await probe('Sequential vs index scans on these tables', () =>
        query(
          `select relname as table, seq_scan, seq_tup_read, idx_scan
             from pg_stat_user_tables where relname in (${tlist})`
        )
      ))
    }
    ev.push(await probe('Blocking locks (if any)', () =>
      query(
        `select blocked.pid as blocked_pid, blocking.pid as blocking_pid,
                blocked.query as blocked_query, blocking.query as blocking_query
           from pg_stat_activity blocked
           join pg_stat_activity blocking on blocking.pid = any(pg_blocking_pids(blocked.pid))
          limit 10`
      )
    ))
    ev.push(await probe('Currently running queries', () =>
      query(
        `select pid, state, wait_event_type, round(extract(epoch from (now()-query_start))::numeric,1) as run_s,
                left(regexp_replace(query, '\\s+', ' ', 'g'), 120) as query
           from pg_stat_activity where state <> 'idle' and pid <> pg_backend_pid()
          order by run_s desc nulls last limit 10`
      )
    ))
  } else if (dialect === 'mysql') {
    ev.push(await probe('Plan (EXPLAIN FORMAT=JSON)', () => query(`EXPLAIN FORMAT=JSON ${sql}`)))
    if (isAnalyzeSafe(sql))
      ev.push(await probe('Plan with actuals (EXPLAIN ANALYZE)', () => query(`EXPLAIN ANALYZE ${sql}`)))
    for (const t of tables.slice(0, 6)) {
      ev.push(await probe(`Indexes on ${t}`, () => query(`SHOW INDEX FROM \`${t}\``)))
    }
    ev.push(await probe('Table sizes & row estimates', () =>
      query(
        `select table_name as \`table\`, table_rows as est_rows,
                round((data_length+index_length)/1024/1024,1) as size_mb
           from information_schema.tables
          where table_schema = database() and table_name in (${tlist})`
      )
    ))
    ev.push(await probe('Running queries', () =>
      query(
        `select id, user, time as run_s, state, left(info, 120) as query
           from information_schema.processlist where command <> 'Sleep' order by time desc limit 10`
      )
    ))
    ev.push(await probe('InnoDB row locks / waits', () =>
      query(`select * from information_schema.innodb_trx limit 10`)
    ))
  } else {
    // Generic SQL engine — gather whatever EXPLAIN the engine accepts.
    ev.push(await probe('Plan (EXPLAIN)', () => query(`EXPLAIN ${sql}`)))
  }
  return ev.filter((e): e is Evidence => !!e)
}

async function healthEvidence(query: Probe, dialect: string): Promise<Evidence[]> {
  const ev: (Evidence | null)[] = []
  if (dialect === 'postgres') {
    ev.push(await probe('Largest tables', () =>
      query(
        `select relname as table, n_live_tup as rows, pg_size_pretty(pg_total_relation_size(relid)) as size
           from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 15`
      )
    ))
    ev.push(await probe('Tables with heavy sequential scans', () =>
      query(
        `select relname as table, seq_scan, idx_scan, n_live_tup as rows
           from pg_stat_user_tables where seq_scan > 0 order by seq_scan desc limit 15`
      )
    ))
    ev.push(await probe('Unused indexes (idx_scan = 0)', () =>
      query(
        `select relname as table, indexrelname as index, pg_size_pretty(pg_relation_size(indexrelid)) as size
           from pg_stat_user_indexes where idx_scan = 0 order by pg_relation_size(indexrelid) desc limit 20`
      )
    ))
    ev.push(await probe('Tables with stale statistics', () =>
      query(
        `select relname as table, last_analyze, last_autoanalyze, n_mod_since_analyze as mods, n_live_tup as rows
           from pg_stat_user_tables
          where n_mod_since_analyze > greatest(1000, n_live_tup * 0.1) order by n_mod_since_analyze desc limit 15`
      )
    ))
    ev.push(await probe('Tables without a primary key', () =>
      query(
        `select t.table_name as table from information_schema.tables t
          where t.table_schema not in ('pg_catalog','information_schema') and t.table_type='BASE TABLE'
            and not exists (
              select 1 from information_schema.table_constraints c
               where c.table_name=t.table_name and c.table_schema=t.table_schema and c.constraint_type='PRIMARY KEY')
          limit 30`
      )
    ))
    ev.push(await probe('Long-running queries', () =>
      query(
        `select pid, round(extract(epoch from (now()-query_start))::numeric,1) as run_s, state,
                left(regexp_replace(query,'\\s+',' ','g'),100) as query
           from pg_stat_activity where state<>'idle' and pid<>pg_backend_pid()
          order by run_s desc nulls last limit 10`
      )
    ))
  } else if (dialect === 'mysql') {
    ev.push(await probe('Largest tables', () =>
      query(
        `select table_name as \`table\`, table_rows as rows,
                round((data_length+index_length)/1024/1024,1) as size_mb
           from information_schema.tables where table_schema=database()
          order by (data_length+index_length) desc limit 15`
      )
    ))
    ev.push(await probe('Tables without a primary key', () =>
      query(
        `select t.table_name as \`table\` from information_schema.tables t
          where t.table_schema=database() and t.table_type='BASE TABLE'
            and not exists (select 1 from information_schema.statistics s
               where s.table_schema=t.table_schema and s.table_name=t.table_name and s.index_name='PRIMARY')
          limit 30`
      )
    ))
    ev.push(await probe('Unused indexes (sys schema)', () =>
      query(`select * from sys.schema_unused_indexes limit 20`)
    ))
    ev.push(await probe('Redundant indexes (sys schema)', () =>
      query(`select * from sys.schema_redundant_indexes limit 20`)
    ))
    ev.push(await probe('Running queries', () =>
      query(
        `select id, time as run_s, state, left(info,100) as query
           from information_schema.processlist where command<>'Sleep' order by time desc limit 10`
      )
    ))
  } else {
    ev.push(await probe('Tables', () => query(`select 1`)))
  }
  return ev.filter((e): e is Evidence => !!e)
}

/** For each table, the newest value in its most likely created/updated timestamp column. */
async function lastActivity(query: Probe, dialect: string): Promise<Evidence | null> {
  if (dialect !== 'postgres' && dialect !== 'mysql') return null
  let cands: QueryResult
  try {
    cands = await query(
      dialect === 'postgres'
        ? `select c.table_name, c.column_name
             from information_schema.columns c
             join information_schema.tables t
               on t.table_name=c.table_name and t.table_schema=c.table_schema and t.table_type='BASE TABLE'
            where c.table_schema not in ('pg_catalog','information_schema')
              and c.data_type in ('timestamp without time zone','timestamp with time zone','date')
              and c.column_name ~* '(creat|insert|updat|modif|_at|date|time)'
            order by c.table_name,
              case when c.column_name ~* 'creat|insert' then 0 when c.column_name ~* '_at' then 1 else 2 end`
        : `select c.table_name, c.column_name
             from information_schema.columns c
             join information_schema.tables t
               on t.table_name=c.table_name and t.table_schema=c.table_schema and t.table_type='BASE TABLE'
            where c.table_schema=database()
              and c.data_type in ('timestamp','datetime','date')
              and c.column_name regexp '(creat|insert|updat|modif|_at|date|time)'
            order by c.table_name`
    )
  } catch {
    return null
  }
  const pick = new Map<string, string>()
  for (const r of cands.rows) {
    const t = String(r[0])
    if (!pick.has(t)) pick.set(t, String(r[1]))
  }
  const tables = [...pick].slice(0, 8) // bound the cost — MAX() may scan
  if (!tables.length) return null
  const lines: string[] = []
  for (const [t, col] of tables) {
    const sql =
      dialect === 'postgres'
        ? `select max("${col.replace(/"/g, '""')}")::text as last_seen from "${t.replace(/"/g, '""')}"`
        : `select max(\`${col.replace(/`/g, '``')}\`) as last_seen from \`${t.replace(/`/g, '``')}\``
    try {
      const res = await query(sql)
      lines.push(`${t}.${col}: last write = ${res.rows[0]?.[0] ?? 'NULL'}`)
    } catch {
      lines.push(`${t}.${col}: (unavailable)`)
    }
  }
  return {
    label: 'Last write per table (newest timestamp) — flags tables that stopped receiving data',
    text: lines.join('\n')
  }
}

/** Cross-cutting evidence for a root-cause investigation, correlating subsystems. */
async function rootCauseEvidence(
  adapter: DbAdapter,
  query: Probe,
  dialect: string,
  connectionId: string
): Promise<Evidence[]> {
  const ev: (Evidence | null)[] = []

  // Recent query history (stored locally) — when did things change / errors begin?
  const hist = listHistory()
    .filter((h) => h.connectionId === connectionId)
    .sort((a, b) => a.ranAt.localeCompare(b.ranAt))
    .slice(-40)
  if (hist.length) {
    ev.push({
      label: `Recent query history (last ${hist.length})`,
      text: hist
        .map(
          (h) =>
            `${h.ranAt}  ${h.durationMs != null ? `${Math.round(h.durationMs)}ms` : '—'}  ` +
            `${h.error ? `ERROR: ${h.error}` : `${h.rowCount ?? '?'} rows`}  ${h.sql.replace(/\s+/g, ' ').slice(0, 110)}`
        )
        .join('\n')
    })
    const errs = hist.filter((h) => h.error)
    if (errs.length)
      ev.push({
        label: 'Recent query errors',
        text: errs.map((h) => `${h.ranAt}  ${h.error} | ${h.sql.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n')
      })
  }

  ev.push(await lastActivity(query, dialect))

  if (dialect === 'postgres')
    ev.push(await probe('Table sizes & row estimates', () =>
      query(
        `select relname as table, n_live_tup as rows, pg_size_pretty(pg_total_relation_size(relid)) as size
           from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 20`
      )
    ))
  else if (dialect === 'mysql')
    ev.push(await probe('Table sizes & row estimates', () =>
      query(
        `select table_name as \`table\`, table_rows as rows, round((data_length+index_length)/1024/1024,1) as size_mb
           from information_schema.tables where table_schema=database() order by (data_length+index_length) desc limit 20`
      )
    ))

  const sizes = listSizes(connectionId)
  if (sizes.length >= 2) {
    const first = sizes[0]
    const last = sizes[sizes.length - 1]
    ev.push({
      label: 'Storage growth (DataDock daily snapshots)',
      text:
        `${sizes.length} snapshots: ${(first.totalBytes / 1e6).toFixed(0)} MB / ${first.tableCount} tables on ${first.at.slice(0, 10)} ` +
        `→ ${(last.totalBytes / 1e6).toFixed(0)} MB / ${last.tableCount} tables on ${last.at.slice(0, 10)}`
    })
  }

  if (adapter.replicationStatus) {
    try {
      const s = await adapter.replicationStatus()
      const parts = [`role: ${s.detectedRole}`]
      if (s.lagSeconds != null) parts.push(`lag: ${s.lagSeconds}s`)
      if (s.replicas?.length)
        parts.push(`replicas: ${s.replicas.map((r) => `${r.name}(${r.lagSeconds ?? '?'}s)`).join(', ')}`)
      if (s.error) parts.push(`note: ${s.error}`)
      ev.push({ label: 'Replication status', text: parts.join(' · ') })
    } catch {
      /* not a replication setup */
    }
  }

  if (adapter.redisQueues) {
    try {
      const qs = await adapter.redisQueues()
      if (qs.length)
        ev.push({
          label: 'Background job queues (Redis)',
          text: qs
            .map(
              (q) =>
                `${q.name} [${q.framework}]: pending=${q.pending} delayed=${q.delayed} reserved=${q.reserved} failed=${q.failed}`
            )
            .join('\n')
        })
    } catch {
      /* not a queue host */
    }
  }

  return ev.filter((e): e is Evidence => !!e)
}

/** Quote an identifier for the dialect. */
function q(dialect: string, ident: string): string {
  return dialect === 'mysql'
    ? `\`${ident.replace(/`/g, '``')}\``
    : `"${ident.replace(/"/g, '""')}"`
}

/** Columns of the given data types whose name matches a regex (filtered client-side). */
async function columnsMatching(
  query: Probe,
  dialect: string,
  nameRe: RegExp,
  types: string[]
): Promise<{ table: string; column: string }[]> {
  const typeList = types.map((t) => `'${t}'`).join(',')
  const sql =
    dialect === 'mysql'
      ? `select table_name, column_name from information_schema.columns where table_schema=database() and data_type in (${typeList})`
      : `select table_name, column_name from information_schema.columns where table_schema not in ('pg_catalog','information_schema') and data_type in (${typeList})`
  try {
    const res = await query(sql)
    return res.rows
      .map((r) => ({ table: String(r[0]), column: String(r[1]) }))
      .filter((c) => nameRe.test(c.column))
  } catch {
    return []
  }
}

/** Heuristic: does a value look like a password hash (vs. plaintext)? */
function looksHashed(v: string): boolean {
  return (
    /^\$(2[aby]|argon2|scrypt|6|5|1)\$/.test(v) ||
    /^\{(sha|ssha|md5)\}/i.test(v) ||
    /^[a-f0-9]{32}$/i.test(v) ||
    /^[a-f0-9]{40}$/i.test(v) ||
    /^[a-f0-9]{64}$/i.test(v) ||
    /^[a-f0-9]{128}$/i.test(v) ||
    (v.length >= 40 && /^[A-Za-z0-9+/=._-]+$/.test(v))
  )
}

// ---- data quality ----
async function dataQualityEvidence(adapter: DbAdapter, query: Probe, dialect: string): Promise<Evidence[]> {
  const ev: (Evidence | null)[] = []

  if (dialect === 'postgres')
    ev.push(await probe('Columns with a high NULL fraction (pg_stats)', () =>
      query(
        `select (schemaname||'.'||tablename) as table, attname as column,
                round(null_frac::numeric,3) as null_frac, n_distinct
           from pg_stats where schemaname not in ('pg_catalog','information_schema') and null_frac >= 0.5
          order by null_frac desc limit 30`
      )
    ))

  const emailCols = await columnsMatching(query, dialect, /email/i,
    dialect === 'mysql' ? ['varchar', 'char', 'text'] : ['character varying', 'varchar', 'text', 'char'])
  for (const { table, column } of emailCols.slice(0, 5)) {
    ev.push(await probe(`Invalid emails in ${table}.${column}`, () =>
      query(
        dialect === 'mysql'
          ? `select count(*) as total, sum(case when ${q(dialect, column)} not regexp '^[^@[:space:]]+@[^@[:space:]]+\\\\.[^@[:space:]]+$' then 1 else 0 end) as invalid from ${q(dialect, table)} where ${q(dialect, column)} is not null`
          : `select count(*) as total, count(*) filter (where ${q(dialect, column)} !~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$') as invalid from ${q(dialect, table)} where ${q(dialect, column)} is not null`
      )
    ))
  }

  const tsCols = await columnsMatching(query, dialect, /(creat|updat|_at|date|time)/i,
    dialect === 'mysql' ? ['timestamp', 'datetime', 'date'] : ['timestamp without time zone', 'timestamp with time zone', 'date'])
  for (const { table, column } of tsCols.slice(0, 5)) {
    ev.push(await probe(`Future-dated rows in ${table}.${column}`, () =>
      query(`select count(*) as future_rows from ${q(dialect, table)} where ${q(dialect, column)} > now()`)
    ))
  }

  const er = await adapter.erModel?.().catch(() => null)
  for (const r of (er?.relations ?? []).slice(0, 6)) {
    ev.push(await probe(`Orphaned ${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn}`, () =>
      query(
        `select count(*) as orphans from ${q(dialect, r.fromTable)} c left join ${q(dialect, r.toTable)} p on c.${q(dialect, r.fromColumn)} = p.${q(dialect, r.toColumn)} where c.${q(dialect, r.fromColumn)} is not null and p.${q(dialect, r.toColumn)} is null`
      )
    ))
  }
  return ev.filter((e): e is Evidence => !!e)
}

// ---- relationship discovery ----
async function relationshipsEvidence(adapter: DbAdapter, query: Probe, dialect: string): Promise<Evidence[]> {
  const er = await adapter.erModel?.().catch(() => null)
  if (!er) return [{ label: 'Relationship discovery', text: '(schema / ER model unavailable for this engine)' }]

  const pkByTable = new Map<string, string>()
  for (const t of er.tables) {
    const pk = t.columns.find((c) => c.isPrimaryKey)
    if (pk) pkByTable.set(t.name.toLowerCase(), pk.name)
  }
  const declared = new Set(er.relations.map((r) => `${r.fromTable.toLowerCase()}.${r.fromColumn.toLowerCase()}`))

  interface Cand { child: string; col: string; parent: string; pk: string }
  const cands: Cand[] = []
  for (const t of er.tables) {
    for (const c of t.columns) {
      if (c.isPrimaryKey) continue
      if (declared.has(`${t.name.toLowerCase()}.${c.name.toLowerCase()}`)) continue
      const m = c.name.match(/^(.*?)_?id$/i)
      if (!m || !m[1]) continue
      const base = m[1].toLowerCase()
      const names = [base, base + 's', base.replace(/s$/, '')]
      const parent = er.tables.find(
        (pt) => names.includes(pt.name.toLowerCase()) && pkByTable.has(pt.name.toLowerCase())
      )
      if (parent && parent.name.toLowerCase() !== t.name.toLowerCase())
        cands.push({ child: t.name, col: c.name, parent: parent.name, pk: pkByTable.get(parent.name.toLowerCase())! })
    }
  }
  if (!cands.length)
    return [{ label: 'Relationship discovery', text: 'No undeclared-FK candidates found by naming heuristics.' }]

  const lines: string[] = []
  for (const cand of cands.slice(0, 10)) {
    try {
      const res = await query(
        `select count(*) as child_nonnull,
                sum(case when p.${q(dialect, cand.pk)} is not null then 1 else 0 end) as matched
           from ${q(dialect, cand.child)} c
           left join ${q(dialect, cand.parent)} p on c.${q(dialect, cand.col)} = p.${q(dialect, cand.pk)}
          where c.${q(dialect, cand.col)} is not null`
      )
      const total = Number(res.rows[0]?.[0] ?? 0)
      const matched = Number(res.rows[0]?.[1] ?? 0)
      const pct = total ? ((matched / total) * 100).toFixed(1) : '0'
      lines.push(`${cand.child}.${cand.col} → ${cand.parent}.${cand.pk}: ${matched}/${total} non-null values match (${pct}%)`)
    } catch {
      lines.push(`${cand.child}.${cand.col} → ${cand.parent}.${cand.pk}: (overlap check failed)`)
    }
  }
  return [{ label: 'Candidate relationships with referential-overlap evidence', text: lines.join('\n') }]
}

// ---- security & privacy audit (raw secret/PII values are never sent to the AI) ----
async function securityEvidence(adapter: DbAdapter, query: Probe, dialect: string): Promise<Evidence[]> {
  const ev: (Evidence | null)[] = []
  let cols: QueryResult | null = null
  try {
    cols = await query(
      dialect === 'mysql'
        ? `select table_name, column_name, data_type from information_schema.columns where table_schema=database()`
        : `select table_name, column_name, data_type from information_schema.columns where table_schema not in ('pg_catalog','information_schema')`
    )
  } catch {
    /* */
  }
  const SENS = /(pass|pwd|secret|token|api[_-]?key|priv[_-]?key|ssn|social|credit|card|cvv|iban|routing|dob|birth|email|phone|salary|mfa|otp)/i
  const all = (cols?.rows ?? []).map((r) => ({ table: String(r[0]), column: String(r[1]), type: String(r[2]) }))
  const sensitive = all.filter((c) => SENS.test(c.column))
  if (sensitive.length)
    ev.push({ label: 'Sensitive-looking columns (by name)', text: sensitive.map((c) => `${c.table}.${c.column} (${c.type})`).join('\n') })

  for (const c of sensitive.filter((c) => /pass|pwd/i.test(c.column)).slice(0, 5)) {
    try {
      const sample = await query(`select ${q(dialect, c.column)} as v from ${q(dialect, c.table)} where ${q(dialect, c.column)} is not null limit 20`)
      const vals = sample.rows.map((r) => String(r[0]))
      if (!vals.length) continue
      const plain = vals.filter((v) => !looksHashed(v)).length
      ev.push({
        label: `Password column ${c.table}.${c.column}`,
        text: `${plain}/${vals.length} sampled values do NOT look like a hash → ${plain > 0 ? 'LIKELY PLAINTEXT or weak hashing' : 'appears hashed'}. (Raw values were not collected.)`
      })
    } catch {
      /* */
    }
  }

  for (const c of all.filter((c) => /text|varchar|char/i.test(c.type) && !SENS.test(c.column)).slice(0, 6)) {
    ev.push(await probe(`Emails embedded in free-text ${c.table}.${c.column}`, () =>
      query(
        dialect === 'mysql'
          ? `select count(*) as rows_with_email from ${q(dialect, c.table)} where ${q(dialect, c.column)} regexp '[[:alnum:]._%+-]+@[[:alnum:].-]+\\\\.[[:alpha:]]{2,}'`
          : `select count(*) as rows_with_email from ${q(dialect, c.table)} where ${q(dialect, c.column)} ~* '[[:alnum:]._%+-]+@[[:alnum:].-]+\\.[[:alpha:]]{2,}'`
      )
    ))
  }

  if (dialect === 'postgres')
    ev.push(await probe('Highly-privileged roles', () =>
      query(`select rolname, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolsuper or rolcreaterole or rolcreatedb order by rolsuper desc limit 30`)
    ))
  else if (dialect === 'mysql')
    ev.push(await probe('Accounts with SUPER / GRANT privileges', () =>
      query(`select user, host, Super_priv, Grant_priv from mysql.user where Super_priv='Y' or Grant_priv='Y' limit 30`)
    ))

  return ev.filter((e): e is Evidence => !!e)
}

// ---- dashboard narrator ----
async function dashboardEvidence(adapter: DbAdapter, query: Probe, connectionId: string): Promise<Evidence[]> {
  const dashboards = listDashboards(connectionId)
  if (!dashboards.length)
    return [{ label: 'Dashboards', text: 'No analytics dashboards are defined for this connection — build one in the Analytics module first.' }]
  const charts = listCharts(connectionId)
  const datasets = listDatasets(connectionId)
  const driver = adapter.config.driver
  const ev: Evidence[] = []
  let budget = 12
  for (const dash of dashboards.slice(0, 3)) {
    const lines: string[] = [`Dashboard: ${dash.name} (${dash.widgets.length} widgets)`]
    for (const w of dash.widgets) {
      if (budget <= 0) break
      const chart = charts.find((c) => c.id === w.chartId)
      const ds = chart && datasets.find((d) => d.id === chart.datasetId)
      if (!chart || !ds) continue
      try {
        const res = await query(buildChartSql(driver, ds.source, chart.encoding))
        lines.push(`\n• ${chart.name} [${chart.type}]\n${asText(res, 12)}`)
        budget--
      } catch (e) {
        lines.push(`\n• ${chart.name}: (could not compute: ${e instanceof Error ? e.message : String(e)})`)
      }
    }
    ev.push({ label: `Dashboard "${dash.name}"`, text: lines.join('\n') })
  }
  return ev
}

// ---- workspace assistant (local query-history mining) ----
function workspaceEvidence(connectionId: string): Evidence[] {
  const hist = listHistory().filter((h) => h.connectionId === connectionId)
  if (!hist.length) return [{ label: 'Workflow', text: 'No query history recorded for this connection yet.' }]

  const tableFreq = new Map<string, number>()
  for (const h of hist) for (const t of tablesInQuery(h.sql)) tableFreq.set(t, (tableFreq.get(t) ?? 0) + 1)
  const topTables = [...tableFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)

  const shapeFreq = new Map<string, number>()
  for (const h of hist) {
    const shape = h.sql.replace(/\s+/g, ' ').replace(/'[^']*'/g, '?').replace(/\b\d+\b/g, '?').trim().slice(0, 140)
    if (shape) shapeFreq.set(shape, (shapeFreq.get(shape) ?? 0) + 1)
  }
  const topShapes = [...shapeFreq.entries()].sort((a, b) => b[1] - a[1]).filter((s) => s[1] > 1).slice(0, 10)
  const errs = hist.filter((h) => h.error).slice(-10)

  const ev: Evidence[] = [
    {
      label: `Workflow summary (${hist.length} queries)`,
      text: `Most-referenced tables: ${topTables.map(([t, n]) => `${t} (${n})`).join(', ') || '—'}`
    }
  ]
  if (topShapes.length)
    ev.push({ label: 'Frequently repeated queries', text: topShapes.map(([s, n]) => `${n}×  ${s}`).join('\n') })
  if (errs.length)
    ev.push({ label: 'Recent errors', text: errs.map((h) => `${h.error} | ${h.sql.replace(/\s+/g, ' ').slice(0, 90)}`).join('\n') })
  return ev
}

// ---- orchestration ----------------------------------------------------------

function reportSchema(): string {
  return (
    `{"summary": string, "score"?: number (0-100), "rating"?: string, ` +
    `"findings": [{"severity": "critical"|"high"|"medium"|"low"|"info", "title": string, ` +
    `"detail": string, "table"?: string, "sql"?: string, "estimatedImpact"?: string}]}`
  )
}

const SYSTEM_BASE =
  `You are a senior database engineer performing a READ-ONLY investigation inside a database client. ` +
  `You are given evidence gathered live from the database. Base EVERY finding strictly on that evidence — ` +
  `never invent table, column or index names that do not appear in it. Put runnable remediation SQL (for the ` +
  `stated dialect) in the "sql" field where you can (e.g. CREATE INDEX, ANALYZE). Order findings most-severe first. ` +
  `Respond with ONLY a JSON object, no prose, matching: `

function parseReport(text: string): InvestigationReport {
  let cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const brace = cleaned.indexOf('{')
  if (brace > 0) cleaned = cleaned.slice(brace)
  const end = cleaned.lastIndexOf('}')
  if (end >= 0) cleaned = cleaned.slice(0, end + 1)
  try {
    const p = JSON.parse(cleaned) as InvestigationReport
    return {
      summary: String(p.summary ?? '').trim() || 'No summary returned.',
      score: typeof p.score === 'number' ? Math.max(0, Math.min(100, Math.round(p.score))) : undefined,
      rating: p.rating,
      findings: Array.isArray(p.findings)
        ? p.findings.map((f) => ({
            severity: f.severity ?? 'info',
            title: String(f.title ?? 'Finding'),
            detail: String(f.detail ?? ''),
            table: f.table || undefined,
            sql: f.sql || undefined,
            estimatedImpact: f.estimatedImpact || undefined
          }))
        : []
    }
  } catch {
    // Model didn't return clean JSON — fall back to a single info finding with the prose.
    return { summary: text.trim().slice(0, 400), findings: [] }
  }
}

export interface InvestigateRequest {
  connectionId: string
  type: InvestigationType
  sql?: string
  /** The symptom/question for a root-cause investigation. */
  question?: string
}

export async function investigate(req: InvestigateRequest): Promise<InvestigationReport> {
  const adapter = getAdapter(req.connectionId)
  const driver = adapter.config.driver
  const dialect = dialectOf(driver)
  const query: Probe = (sql) => adapter.query(sql)

  let evidence: Evidence[] = []
  let task = ''

  if (req.type === 'query') {
    if (!req.sql?.trim()) throw new Error('No query to investigate.')
    evidence = await queryEvidence(query, req.sql.trim(), dialect)
    task =
      `Investigate why this specific query is slow or expensive. Identify the PRIMARY cause first ` +
      `(quote the estimated share of cost/time when the plan shows it), then additional findings and ` +
      `concrete remediations with estimated improvement.\n\nQuery under investigation:\n${req.sql.trim()}`
  } else if (req.type === 'health') {
    evidence = await healthEvidence(query, dialect)
    task =
      `Produce an overall database health assessment. Set "score" (0-100) and a one-word "rating" ` +
      `(e.g. Excellent/Good/Fair/Poor). Surface the biggest opportunities as findings, each linking to the ` +
      `affected table and a remediation SQL where possible.`
  } else if (req.type === 'rootCause') {
    const question =
      req.question?.trim() || 'Identify any anomalies or likely problems in this database right now.'
    evidence = await rootCauseEvidence(adapter, query, dialect, req.connectionId)
    task =
      `Perform a ROOT CAUSE analysis of the user's reported symptom by correlating the cross-cutting evidence ` +
      `(recent query history & errors, last-write-per-table, table sizes, storage growth, replication health, and ` +
      `job queues). In "summary", state the SINGLE most likely explanation with a brief confidence note — and when ` +
      `the evidence is consistent with a timeline (e.g. a table that stopped receiving rows at a certain time), say so. ` +
      `Use "findings" both for the supporting signals (most relevant first) AND for the things you ruled OUT (use ` +
      `severity "info" for rule-outs). When a finding points at a table set "table"; put a confirming or remediation ` +
      `query in "sql" where useful.\n\nUser's question / symptom:\n${question}`
  } else if (req.type === 'dataQuality') {
    evidence = await dataQualityEvidence(adapter, query, dialect)
    task =
      `Inspect the database for DATA QUALITY problems from the evidence (high-NULL columns, invalid emails, ` +
      `future-dated rows, orphaned foreign-key rows). For each issue give a severity, the likely cause, and a ` +
      `SAFE cleanup approach — prefer a SELECT that previews the affected rows in "sql" before any change. Set "table".`
  } else if (req.type === 'relationships') {
    evidence = await relationshipsEvidence(adapter, query, dialect)
    task =
      `Discover undeclared foreign-key RELATIONSHIPS. For each strong candidate, state the relationship and a ` +
      `confidence from the referential-overlap % (and naming). Put the child table in "table" and an ` +
      `"ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …" statement in "sql". Severity reflects confidence ` +
      `(high ≈ ≥99% overlap, low/info for weak matches). Mention if a column has orphan values that would block the FK.`
  } else if (req.type === 'security') {
    evidence = await securityEvidence(adapter, query, dialect)
    task =
      `Perform a SECURITY & PRIVACY audit. Flag plaintext passwords / secrets (critical), unmasked PII (high), ` +
      `sensitive columns and over-privileged accounts. Recommend remediation (hashing, masking, least-privilege) in ` +
      `"detail"; only put SQL in "sql" when it is safe and clearly correct. NOTE: raw secret/PII values were ` +
      `deliberately NOT collected — reason only from the provided verdicts and counts.`
  } else if (req.type === 'dashboard') {
    evidence = await dashboardEvidence(adapter, query, req.connectionId)
    task =
      `Write an EXECUTIVE SUMMARY of the analytics dashboard(s) for a non-technical stakeholder. In "summary", give ` +
      `a concise narrative of what the numbers say (trends, standouts, anything notable). Use "findings" (severity ` +
      `"info") for individual highlights per chart. Do NOT invent numbers beyond the provided data, and do not set a score or SQL.`
  } else if (req.type === 'workspace') {
    evidence = workspaceEvidence(req.connectionId)
    task =
      `Act as a WORKSPACE ASSISTANT. From the user's local query history, suggest ways to speed up their workflow: ` +
      `tables worth pinning, repeated queries worth saving as snippets, and any error patterns to fix. Output ` +
      `suggestions as findings (severity "info"); when you propose a reusable query put it in "sql" and the relevant ` +
      `table in "table". Be practical and specific to their actual usage. Do not set a score.`
  } else {
    // schema understanding
    const schema = await adapter.schema?.().catch(() => ({}) as Record<string, string[]>)
    const schemaText = Object.entries(schema ?? {})
      .map(([t, cols]) => `${t}(${cols.join(', ')})`)
      .join('\n')
    evidence = [{ label: 'Schema (tables & columns)', text: schemaText || '(unavailable)' }]
    const er = await adapter.erModel?.().catch(() => null)
    if (er?.relations?.length) {
      evidence.push({
        label: 'Declared foreign-key relationships',
        text: er.relations.map((r) => `${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn}`).join('\n')
      })
    }
    task =
      `Explain what this database does as a whole in "summary": the business domain it appears to power, ` +
      `the core entities and how they relate. Use "findings" (severity "info") for per-area notes, the purpose ` +
      `of ambiguous tables, and suggestions for clearer names. Do not set a score.`
  }

  const system =
    SYSTEM_BASE +
    reportSchema() +
    ` The database dialect is ${dialect === 'generic' ? driver : dialect}.`
  const evidenceText = evidence.map((e) => `### ${e.label}\n${e.text}`).join('\n\n')
  const user = `${task}\n\n--- EVIDENCE ---\n\n${evidenceText}`

  const raw = await complete({ system, user })
  return parseReport(raw)
}
