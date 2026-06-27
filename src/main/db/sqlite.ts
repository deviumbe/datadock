import Database from 'better-sqlite3'
import type {
  AlterOp,
  ConnectionConfig,
  CreateTableSpec,
  DropTableOptions,
  TruncateOptions,
  QueryResult,
  RowChangeSet,
  TableInfo,
  TableQueryOptions,
  TableSizeInfo,
  TableStructure
} from '@shared/types'
import { DbAdapter, now } from './types'
import { buildClauses, buildErModel, buildSnapshot, groupIndexes, indexName } from './clauses'
import type { ErModel, SchemaSnapshot } from '@shared/types'

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`

export class SQLiteAdapter implements DbAdapter {
  private db?: Database.Database
  constructor(public readonly config: ConnectionConfig) {}

  private open(readonly = false): Database.Database {
    if (!this.config.filePath) throw new Error('No SQLite file path configured')
    return new Database(this.config.filePath, { readonly, fileMustExist: false })
  }

  async test(): Promise<void> {
    const db = this.open(true)
    try {
      db.prepare('select 1').get()
    } finally {
      db.close()
    }
  }

  async connect(): Promise<void> {
    this.db = this.open(false)
  }

  async disconnect(): Promise<void> {
    this.db?.close()
    this.db = undefined
  }

  async beginTransaction(): Promise<void> {
    this.db!.exec('begin')
  }
  async commitTransaction(): Promise<void> {
    this.db!.exec('commit')
  }
  async rollbackTransaction(): Promise<void> {
    this.db!.exec('rollback')
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = this.db!
      .prepare(
        `select name, type from sqlite_master
          where type in ('table', 'view') and name not like 'sqlite_%'
          order by type, name`
      )
      .all() as { name: string; type: string }[]
    return rows.map((r) => ({ name: r.name, type: r.type === 'view' ? 'view' : 'table' }))
  }

  async tableData(table: TableInfo, opts: TableQueryOptions): Promise<QueryResult> {
    const { where, order, params } = buildClauses(opts, q, () => '?')
    const sql = `select * from ${q(table.name)}${where}${order} limit ${opts.limit} offset ${opts.offset}`
    const start = now()
    const stmt = this.db!.prepare(sql)
    const objects = stmt.all(...(params as never[])) as Record<string, unknown>[]
    const columns = stmt.columns().map((c) => ({ name: c.name, type: c.type ?? undefined }))
    const names = columns.map((c) => c.name)
    const rows = objects.map((o) => names.map((n) => normalizeValue(o[n])))
    return { columns, rows, rowCount: rows.length, durationMs: now() - start }
  }

  async countRows(table: TableInfo, opts: TableQueryOptions): Promise<number> {
    const { where, params } = buildClauses(opts, q, () => '?')
    const row = this.db!
      .prepare(`select count(*) as cnt from ${q(table.name)}${where}`)
      .get(...(params as never[])) as { cnt: number } | undefined
    return Number(row?.cnt ?? 0)
  }

  async primaryKeys(table: TableInfo): Promise<string[]> {
    const rows = this.db!.prepare(`pragma table_info(${q(table.name)})`).all() as {
      name: string
      pk: number
    }[]
    return rows
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name)
  }

  async applyChanges(table: TableInfo, cs: RowChangeSet): Promise<number> {
    const db = this.db!
    const t = q(table.name)
    const txn = db.transaction((changes: RowChangeSet) => {
      let affected = 0

      for (const pk of changes.deletes) {
        const cols = Object.keys(pk)
        const where = cols.map((c) => `${q(c)} = ?`).join(' and ')
        const info = db.prepare(`delete from ${t} where ${where}`).run(...cols.map((c) => pk[c] as never))
        affected += info.changes
      }

      for (const e of changes.updates) {
        const setCols = Object.keys(e.changes)
        const pkCols = Object.keys(e.pk)
        const set = setCols.map((c) => `${q(c)} = ?`).join(', ')
        const where = pkCols.map((c) => `${q(c)} = ?`).join(' and ')
        const info = db
          .prepare(`update ${t} set ${set} where ${where}`)
          .run(...setCols.map((c) => e.changes[c] as never), ...pkCols.map((c) => e.pk[c] as never))
        affected += info.changes
      }

      for (const row of changes.inserts) {
        const cols = Object.keys(row)
        if (cols.length === 0) continue
        const placeholders = cols.map(() => '?').join(', ')
        db.prepare(`insert into ${t} (${cols.map(q).join(', ')}) values (${placeholders})`).run(
          ...cols.map((c) => row[c] as never)
        )
        affected++
      }

      return affected
    })
    return txn(cs)
  }

  async schema(): Promise<Record<string, string[]>> {
    const rows = this.db!
      .prepare(
        `select m.name as t, p.name as c from sqlite_master m
           join pragma_table_info(m.name) p
          where m.type in ('table', 'view') and m.name not like 'sqlite_%'
          order by m.name, p.cid`
      )
      .all() as { t: string; c: string }[]
    const map: Record<string, string[]> = {}
    for (const r of rows) (map[r.t] ??= []).push(r.c)
    return map
  }

  async tableSizes(): Promise<TableSizeInfo[]> {
    const tables = this.db!
      .prepare(
        `select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`
      )
      .all() as { name: string }[]
    // Per-table byte size needs the dbstat vtab (not always compiled in), so we
    // try it once and fall back to row counts only.
    let sizeByName: Record<string, number> = {}
    try {
      const stats = this.db!
        .prepare(`select name, sum(pgsize) as bytes from dbstat group by name`)
        .all() as { name: string; bytes: number }[]
      sizeByName = Object.fromEntries(stats.map((s) => [s.name, s.bytes]))
    } catch {
      sizeByName = {}
    }
    const out: TableSizeInfo[] = tables.map(({ name }) => {
      const row = this.db!.prepare(`select count(*) as n from ${q(name)}`).get() as { n: number }
      return { name, rows: row?.n ?? null, bytes: sizeByName[name] ?? null }
    })
    return out.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || (b.rows ?? 0) - (a.rows ?? 0))
  }

  async createTable(spec: CreateTableSpec): Promise<void> {
    const lines = spec.columns.map((c) => {
      let l = `${q(c.name)} ${c.type}`
      if (!c.nullable) l += ' not null'
      if (c.default) l += ` default ${c.default}`
      return l
    })
    const pks = spec.columns.filter((c) => c.primaryKey).map((c) => q(c.name))
    if (pks.length) lines.push(`primary key (${pks.join(', ')})`)
    this.db!.exec(`create table ${q(spec.name)} (${lines.join(', ')})`)
  }

  async dropTables(tables: TableInfo[], opts: DropTableOptions): Promise<void> {
    const off = !!(opts.ignoreForeignKeys || opts.cascade)
    if (off) this.db!.pragma('foreign_keys = OFF')
    try {
      const txn = this.db!.transaction(() => {
        for (const t of tables) this.db!.exec(`drop table if exists ${q(t.name)}`)
      })
      txn()
    } finally {
      if (off) this.db!.pragma('foreign_keys = ON')
    }
  }

  async truncateTables(tables: TableInfo[], opts: TruncateOptions): Promise<void> {
    // SQLite has no TRUNCATE — DELETE every row. Reset rowids via sqlite_sequence
    // (only present once a table uses AUTOINCREMENT).
    const off = !!opts.ignoreForeignKeys
    const hasSeq = !!this.db!
      .prepare(`select 1 from sqlite_master where type = 'table' and name = 'sqlite_sequence'`)
      .get()
    if (off) this.db!.pragma('foreign_keys = OFF')
    try {
      const txn = this.db!.transaction(() => {
        for (const t of tables) {
          this.db!.exec(`delete from ${q(t.name)}`)
          if (opts.restartIdentity && hasSeq) {
            this.db!.prepare(`delete from sqlite_sequence where name = ?`).run(t.name)
          }
        }
      })
      txn()
    } finally {
      if (off) this.db!.pragma('foreign_keys = ON')
    }
  }

  async erModel(): Promise<ErModel> {
    const tables = this.db!
      .prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`)
      .all() as { name: string }[]
    const cols: { t: string; col: string; isPk: boolean }[] = []
    const rels: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }[] = []
    for (const { name } of tables) {
      const info = this.db!.prepare(`pragma table_info(${q(name)})`).all() as {
        name: string
        pk: number
      }[]
      for (const ci of info) cols.push({ t: name, col: ci.name, isPk: ci.pk > 0 })
      const fks = this.db!.prepare(`pragma foreign_key_list(${q(name)})`).all() as {
        from: string
        table: string
        to: string
      }[]
      for (const fk of fks)
        rels.push({ fromTable: name, fromColumn: fk.from, toTable: fk.table, toColumn: fk.to })
    }
    return buildErModel(cols, rels)
  }

  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const tables = this.db!
      .prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`)
      .all() as { name: string }[]
    const rows: { t: string; col: string; type: string; nullable: boolean; isPk: boolean }[] = []
    for (const { name } of tables) {
      const info = this.db!.prepare(`pragma table_info(${q(name)})`).all() as {
        name: string
        type: string
        notnull: number
        pk: number
      }[]
      for (const ci of info) {
        rows.push({ t: name, col: ci.name, type: ci.type || 'BLOB', nullable: ci.notnull === 0, isPk: ci.pk > 0 })
      }
    }
    return buildSnapshot(rows)
  }

  async tableDDL(table: TableInfo): Promise<string> {
    const row = this.db!
      .prepare(`select sql from sqlite_master where name = ? and sql is not null`)
      .get(table.name) as { sql: string } | undefined
    return row ? `${row.sql};` : ''
  }

  async tableStructure(table: TableInfo): Promise<TableStructure> {
    const cols = this.db!.prepare(`pragma table_info(${q(table.name)})`).all() as {
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }[]
    const fks = this.db!.prepare(`pragma foreign_key_list(${q(table.name)})`).all() as {
      id: number
      from: string
      table: string
      to: string
    }[]
    const idxList = this.db!.prepare(`pragma index_list(${q(table.name)})`).all() as {
      name: string
      unique: number
      origin: string
    }[]
    const idxRows: { name: string; unique: boolean; col: string }[] = []
    for (const ix of idxList) {
      if (ix.origin === 'pk') continue
      const info = this.db!.prepare(`pragma index_info(${q(ix.name)})`).all() as {
        seqno: number
        name: string
      }[]
      for (const col of info.sort((a, b) => a.seqno - b.seqno)) {
        idxRows.push({ name: ix.name, unique: ix.unique === 1, col: col.name })
      }
    }

    return {
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type || 'BLOB',
        nullable: c.notnull === 0,
        default: c.dflt_value,
        isPrimaryKey: c.pk > 0
      })),
      foreignKeys: fks.map((f) => ({
        name: `fk_${f.id}`,
        column: f.from,
        refTable: f.table,
        refColumn: f.to
      })),
      indexes: groupIndexes(idxRows)
    }
  }

  async alterTable(table: TableInfo, op: AlterOp): Promise<void> {
    const t = q(table.name)
    switch (op.kind) {
      case 'addColumn':
        this.db!.exec(
          `alter table ${t} add column ${q(op.name)} ${op.type}${op.nullable ? '' : ' not null'}${op.default ? ` default ${op.default}` : ''}`
        )
        return
      case 'dropColumn':
        this.db!.exec(`alter table ${t} drop column ${q(op.name)}`)
        return
      case 'renameColumn':
        this.db!.exec(`alter table ${t} rename column ${q(op.from)} to ${q(op.to)}`)
        return
      case 'addIndex': {
        const name = op.name || indexName(table.name, op.columns)
        this.db!.exec(
          `create ${op.unique ? 'unique ' : ''}index ${q(name)} on ${t} (${op.columns.map(q).join(', ')})`
        )
        return
      }
      case 'dropIndex':
        this.db!.exec(`drop index ${q(op.name)}`)
        return
      default:
        throw new Error(
          `SQLite can't "${op.kind}" in place — recreate the table to change types, nullability, or foreign keys.`
        )
    }
  }

  async query(sql: string): Promise<QueryResult> {
    const start = now()
    let stmt: Database.Statement
    try {
      stmt = this.db!.prepare(sql)
    } catch (err) {
      // better-sqlite3 rejects multi-statement SQL in prepare(); fall back to exec.
      this.db!.exec(sql)
      return { columns: [], rows: [], rowCount: 0, durationMs: now() - start }
    }

    if (stmt.reader) {
      const objects = stmt.all() as Record<string, unknown>[]
      const columns = stmt.columns().map((c) => ({ name: c.name, type: c.type ?? undefined }))
      const names = columns.map((c) => c.name)
      const rows = objects.map((o) => names.map((n) => normalizeValue(o[n])))
      return { columns, rows, rowCount: rows.length, durationMs: now() - start }
    }

    const info = stmt.run()
    return { columns: [], rows: [], rowCount: 0, affectedRows: info.changes, durationMs: now() - start }
  }
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`
  if (typeof v === 'bigint') return v.toString()
  return v
}
