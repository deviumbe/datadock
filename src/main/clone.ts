import { dialog } from 'electron'
import { existsSync, unlinkSync } from 'fs'
import Database from 'better-sqlite3'
import type { CloneOptions, CloneResult, ColumnDef, TableInfo, TableStructure } from '@shared/types'
import { getAdapter } from './db'

const PAGE = 2000

/** Quote a SQLite identifier. */
const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`

/**
 * Map an arbitrary SQL column type to a SQLite affinity. SQLite types are
 * advisory (affinity-based), so a coarse keyword match is enough to keep
 * INTEGER/REAL/NUMERIC/BLOB/TEXT columns behaving sensibly.
 */
function sqliteType(type: string): string {
  const t = (type || '').toLowerCase()
  if (/\b(bool|boolean|bit)\b/.test(t)) return 'INTEGER'
  if (/(serial|int\b|integer|bigint|smallint|tinyint|mediumint|int2|int4|int8|year)/.test(t))
    return 'INTEGER'
  if (/(decimal|numeric|money|number)/.test(t)) return 'NUMERIC'
  if (/(real|float|double|precision)/.test(t)) return 'REAL'
  if (/(blob|binary|bytea|image|varbinary)/.test(t)) return 'BLOB'
  return 'TEXT'
}

/** Build a SQLite CREATE TABLE from a source table's structure. */
function createTableSql(
  table: TableInfo,
  struct: TableStructure,
  cloned: ReadonlySet<string>
): string {
  const cols = struct.columns.map((c: ColumnDef) => {
    let line = `  ${q(c.name)} ${sqliteType(c.type)}`
    if (!c.nullable) line += ' NOT NULL'
    return line
  })

  const pk = struct.columns.filter((c) => c.isPrimaryKey).map((c) => q(c.name))
  if (pk.length) cols.push(`  PRIMARY KEY (${pk.join(', ')})`)

  // Foreign keys, but only to tables that are also part of this clone.
  for (const fk of struct.foreignKeys) {
    if (!cloned.has(fk.refTable)) continue
    cols.push(`  FOREIGN KEY (${q(fk.column)}) REFERENCES ${q(fk.refTable)} (${q(fk.refColumn)})`)
  }

  return `CREATE TABLE ${q(table.name)} (\n${cols.join(',\n')}\n)`
}

/** Coerce a source cell into a value better-sqlite3 can bind. */
function toSqliteValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'bigint') return v
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return v
  if (typeof v === 'object') return JSON.stringify(v)
  return v as string | number
}

/**
 * Clone a connection's schema (and optionally data) into a fresh SQLite file.
 * Prompts for the destination path; returns canceled:true if the user backs out.
 */
export async function cloneToSqlite(connId: string, opts: CloneOptions): Promise<CloneResult> {
  const adapter = getAdapter(connId)
  if (!adapter.tableStructure || !adapter.listTables) {
    throw new Error('This engine cannot be cloned to SQLite.')
  }

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Clone to SQLite',
    defaultPath: `${adapter.config.name || 'clone'}.sqlite`,
    filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db', 'sqlite3'] }]
  })
  if (canceled || !filePath) return { canceled: true }

  // Start from a clean file so a re-clone doesn't collide with old tables.
  if (existsSync(filePath)) unlinkSync(filePath)

  const allTables = (await adapter.listTables()).filter((t) => t.type === 'table')
  const wanted = opts.tables.length ? new Set(opts.tables) : null
  const tables = wanted ? allTables.filter((t) => wanted.has(t.name)) : allTables
  const clonedNames = new Set(tables.map((t) => t.name))

  const db = new Database(filePath)
  const errors: string[] = []
  let rowCount = 0
  try {
    db.pragma('foreign_keys = OFF')
    db.pragma('journal_mode = WAL')

    // Read every structure first, then create tables + indexes in one pass.
    const structs = new Map<string, TableStructure>()
    for (const t of tables) {
      structs.set(t.name, await adapter.tableStructure!(t))
    }

    db.exec('BEGIN')
    for (const t of tables) {
      const struct = structs.get(t.name)!
      db.exec(createTableSql(t, struct, clonedNames))
      for (const idx of struct.indexes) {
        // Skip the implicit primary-key index; SQLite makes its own.
        const pkCols = struct.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
        const sameAsPk =
          idx.columns.length === pkCols.length && idx.columns.every((c) => pkCols.includes(c))
        if (sameAsPk) continue
        const name = `${t.name}_${idx.columns.join('_')}_idx`.replace(/[^A-Za-z0-9_]/g, '_')
        const cols = idx.columns.map(q).join(', ')
        db.exec(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${q(t.name)} (${cols})`)
      }
    }
    db.exec('COMMIT')

    if (opts.includeData) {
      for (const t of tables) {
        try {
          const struct = structs.get(t.name)!
          const colNames = struct.columns.map((c) => c.name)
          const placeholders = colNames.map(() => '?').join(', ')
          const insert = db.prepare(
            `INSERT INTO ${q(t.name)} (${colNames.map(q).join(', ')}) VALUES (${placeholders})`
          )
          const insertMany = db.transaction((rows: unknown[][]) => {
            for (const row of rows) insert.run(row.map(toSqliteValue))
          })

          let offset = 0
          for (;;) {
            const r = await adapter.tableData(t, { limit: PAGE, offset })
            // Align the page's columns to our table column order.
            const colIndex = new Map(r.columns.map((c, i) => [c.name, i]))
            const aligned = r.rows.map((row) =>
              colNames.map((name) => {
                const i = colIndex.get(name)
                return i === undefined ? null : (row as unknown[])[i]
              })
            )
            insertMany(aligned)
            rowCount += aligned.length
            if (r.rows.length < PAGE) break
            offset += PAGE
          }
        } catch (e) {
          errors.push(`${t.name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }

    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }

  return { canceled: false, path: filePath, tableCount: tables.length, rowCount, errors }
}
