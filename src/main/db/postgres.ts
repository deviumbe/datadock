import pg from 'pg'
import type {
  AlterOp,
  ConnectionConfig,
  QueryResult,
  RowChangeSet,
  TableInfo,
  TableQueryOptions,
  TableStructure
} from '@shared/types'
import { DbAdapter, now, assertIdent } from './types'
import { buildClauses, groupIndexes, indexName } from './clauses'

// Return numeric/bigint columns as strings instead of JS numbers where lossy,
// and dates as ISO strings so they serialize cleanly over IPC.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v) // bigint -> string
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v)

export class PostgresAdapter implements DbAdapter {
  private pool?: pg.Pool
  constructor(public readonly config: ConnectionConfig) {}

  private makePool(): pg.Pool {
    return new pg.Pool({
      host: this.config.host,
      port: this.config.port ?? 5432,
      database: this.config.database || undefined,
      user: this.config.user,
      password: this.config.password,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      max: 4,
      connectionTimeoutMillis: 10_000
    })
  }

  async test(): Promise<void> {
    const pool = this.makePool()
    try {
      const client = await pool.connect()
      client.release()
    } finally {
      await pool.end()
    }
  }

  async connect(): Promise<void> {
    this.pool = this.makePool()
    const client = await this.pool.connect()
    client.release()
  }

  async disconnect(): Promise<void> {
    await this.pool?.end()
    this.pool = undefined
  }

  async listTables(): Promise<TableInfo[]> {
    const res = await this.pool!.query(
      `select table_schema as schema, table_name as name, table_type
         from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema')
        order by table_schema, table_name`
    )
    return res.rows.map((r) => ({
      schema: r.schema as string,
      name: r.name as string,
      type: r.table_type === 'VIEW' ? 'view' : 'table'
    }))
  }

  async schema(): Promise<Record<string, string[]>> {
    const res = await this.pool!.query(
      `select table_name as t, column_name as c from information_schema.columns
        where table_schema not in ('pg_catalog', 'information_schema')
        order by table_name, ordinal_position`
    )
    const map: Record<string, string[]> = {}
    for (const r of res.rows) (map[r.t as string] ??= []).push(r.c as string)
    return map
  }

  private ident(table: TableInfo): string {
    return `${quoteIdent(table.schema ?? 'public')}.${quoteIdent(table.name)}`
  }

  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const { where, order, params } = buildClauses(opts, quoteIdent, (i) => `$${i}`)
    const sql = `select * from ${this.ident(table)}${where}${order} limit ${opts.limit} offset ${opts.offset}`
    const start = now()
    const res = await this.pool!.query({ text: sql, rowMode: 'array', values: params })
    const columns = (res.fields ?? []).map((f) => ({ name: f.name }))
    return {
      columns,
      rows: normalizeRows((res.rows ?? []) as unknown[][]),
      rowCount: res.rowCount ?? res.rows?.length ?? 0,
      durationMs: now() - start
    }
  }

  async primaryKeys(table: TableInfo): Promise<string[]> {
    const res = await this.pool!.query(
      `select a.attname as col
         from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = $1::regclass and i.indisprimary
        order by array_position(i.indkey, a.attnum)`,
      [this.ident(table)]
    )
    return res.rows.map((r) => r.col as string)
  }

  async applyChanges(table: TableInfo, cs: RowChangeSet): Promise<number> {
    const client = await this.pool!.connect()
    const t = this.ident(table)
    try {
      await client.query('begin')
      let affected = 0

      for (const pk of cs.deletes) {
        const params: unknown[] = []
        const where = Object.keys(pk)
          .map((c) => {
            params.push(pk[c])
            return `${quoteIdent(c)} = $${params.length}`
          })
          .join(' and ')
        const r = await client.query(`delete from ${t} where ${where}`, params)
        affected += r.rowCount ?? 0
      }

      for (const e of cs.updates) {
        const params: unknown[] = []
        const set = Object.keys(e.changes)
          .map((c) => {
            params.push(e.changes[c])
            return `${quoteIdent(c)} = $${params.length}`
          })
          .join(', ')
        const where = Object.keys(e.pk)
          .map((c) => {
            params.push(e.pk[c])
            return `${quoteIdent(c)} = $${params.length}`
          })
          .join(' and ')
        const r = await client.query(`update ${t} set ${set} where ${where}`, params)
        affected += r.rowCount ?? 0
      }

      for (const row of cs.inserts) {
        const cols = Object.keys(row)
        if (cols.length === 0) continue
        const params: unknown[] = []
        const placeholders = cols.map((c) => {
          params.push(row[c])
          return `$${params.length}`
        })
        await client.query(
          `insert into ${t} (${cols.map(quoteIdent).join(', ')}) values (${placeholders.join(', ')})`,
          params
        )
        affected++
      }

      await client.query('commit')
      return affected
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
  }

  async query(sql: string): Promise<QueryResult> {
    const start = now()
    const res = await this.pool!.query({ text: sql, rowMode: 'array' })
    const durationMs = now() - start
    const columns = (res.fields ?? []).map((f) => ({ name: f.name }))
    const rows = (res.rows ?? []) as unknown[][]
    return {
      columns,
      rows: normalizeRows(rows),
      rowCount: res.rowCount ?? rows.length,
      durationMs,
      command: res.command
    }
  }

  async tableDDL(table: TableInfo): Promise<string> {
    const schema = table.schema ?? 'public'
    const cols = await this.pool!.query(
      `select column_name, data_type, character_maximum_length, is_nullable, column_default
         from information_schema.columns
        where table_schema = $1 and table_name = $2
        order by ordinal_position`,
      [schema, table.name]
    )
    const pks = await this.primaryKeys(table)
    const lines = cols.rows.map((c) => {
      let type = c.data_type as string
      if (c.character_maximum_length) type += `(${c.character_maximum_length})`
      let line = `  ${quoteIdent(c.column_name)} ${type}`
      if (c.column_default) line += ` default ${c.column_default}`
      if (c.is_nullable === 'NO') line += ' not null'
      return line
    })
    if (pks.length) lines.push(`  primary key (${pks.map(quoteIdent).join(', ')})`)
    return `create table ${this.ident(table)} (\n${lines.join(',\n')}\n);`
  }

  async tableStructure(table: TableInfo): Promise<TableStructure> {
    const schema = table.schema ?? 'public'
    const cols = await this.pool!.query(
      `select column_name, data_type, character_maximum_length, is_nullable, column_default
         from information_schema.columns
        where table_schema = $1 and table_name = $2
        order by ordinal_position`,
      [schema, table.name]
    )
    const pks = await this.primaryKeys(table)
    const fks = await this.pool!.query(
      `select tc.constraint_name as name, kcu.column_name as col,
              ccu.table_name as ref_table, ccu.column_name as ref_column
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
        where tc.constraint_type = 'FOREIGN KEY' and tc.table_name = $1 and tc.table_schema = $2`,
      [table.name, schema]
    )
    const idx = await this.pool!.query(
      `select i.relname as name, ix.indisunique as is_unique, a.attname as col,
              array_position(ix.indkey, a.attnum) as ord
         from pg_class t
         join pg_namespace n on n.oid = t.relnamespace
         join pg_index ix on t.oid = ix.indrelid
         join pg_class i on i.oid = ix.indexrelid
         join pg_attribute a on a.attrelid = t.oid and a.attnum = any(ix.indkey)
        where t.relname = $2 and n.nspname = $1 and not ix.indisprimary
        order by i.relname, ord`,
      [schema, table.name]
    )

    return {
      columns: cols.rows.map((c) => ({
        name: c.column_name as string,
        type: c.character_maximum_length
          ? `${c.data_type}(${c.character_maximum_length})`
          : (c.data_type as string),
        nullable: c.is_nullable === 'YES',
        default: c.column_default ?? null,
        isPrimaryKey: pks.includes(c.column_name)
      })),
      foreignKeys: fks.rows.map((f) => ({
        name: f.name as string,
        column: f.col as string,
        refTable: f.ref_table as string,
        refColumn: f.ref_column as string
      })),
      indexes: groupIndexes(
        idx.rows.map((r) => ({ name: r.name as string, unique: !!r.is_unique, col: r.col as string }))
      )
    }
  }

  async alterTable(table: TableInfo, op: AlterOp): Promise<void> {
    const t = this.ident(table)
    const q = quoteIdent
    let sql: string
    switch (op.kind) {
      case 'addColumn':
        sql = `alter table ${t} add column ${q(assertIdent(op.name))} ${op.type}${op.nullable ? '' : ' not null'}${op.default ? ` default ${op.default}` : ''}`
        break
      case 'dropColumn':
        sql = `alter table ${t} drop column ${q(op.name)}`
        break
      case 'renameColumn':
        sql = `alter table ${t} rename column ${q(op.from)} to ${q(assertIdent(op.to))}`
        break
      case 'changeType':
        sql = `alter table ${t} alter column ${q(op.name)} type ${op.type}`
        break
      case 'setNullable':
        sql = `alter table ${t} alter column ${q(op.name)} ${op.nullable ? 'drop not null' : 'set not null'}`
        break
      case 'addForeignKey': {
        const name = op.name || `fk_${table.name}_${op.column}`
        sql = `alter table ${t} add constraint ${q(assertIdent(name))} foreign key (${q(op.column)}) references ${q(op.refTable)} (${q(op.refColumn)})${op.onDelete ? ` on delete ${op.onDelete}` : ''}`
        break
      }
      case 'dropForeignKey':
        sql = `alter table ${t} drop constraint ${q(op.name)}`
        break
      case 'addIndex': {
        const name = op.name || indexName(table.name, op.columns)
        sql = `create ${op.unique ? 'unique ' : ''}index ${q(assertIdent(name))} on ${t} (${op.columns.map(q).join(', ')})`
        break
      }
      case 'dropIndex':
        sql = `drop index ${quoteIdent(table.schema ?? 'public')}.${q(op.name)}`
        break
    }
    await this.pool!.query(sql)
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.pool!.query(
      `select datname from pg_database where datistemplate = false order by datname`
    )
    return res.rows.map((r) => r.datname as string)
  }

  async createDatabase(name: string): Promise<void> {
    await this.pool!.query(`create database ${quoteIdent(assertIdent(name))}`)
  }

  async dropDatabase(name: string): Promise<void> {
    await this.pool!.query(`drop database ${quoteIdent(assertIdent(name))}`)
  }

  async listProcesses(): Promise<QueryResult> {
    return this.query(
      `select pid, usename as "user", datname as database, state,
              client_addr, wait_event_type, query_start,
              left(query, 200) as query
         from pg_stat_activity
        where pid <> pg_backend_pid()
        order by query_start desc nulls last`
    )
  }

  async killProcess(id: string | number): Promise<void> {
    await this.pool!.query('select pg_terminate_backend($1)', [Number(id)])
  }

  async listUsers(): Promise<QueryResult> {
    return this.query(
      `select rolname as role, rolsuper as superuser, rolcreatedb as create_db,
              rolcanlogin as can_login, rolconnlimit as conn_limit
         from pg_roles order by rolname`
    )
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function normalizeRows(rows: unknown[][]): unknown[][] {
  return rows.map((row) => row.map(normalizeValue))
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex')}`
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}
