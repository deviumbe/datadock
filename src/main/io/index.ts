import { dialog, BrowserWindow } from 'electron'
import { writeFile, readFile, unlink, rename, stat } from 'fs/promises'
import { createWriteStream, createReadStream, type WriteStream } from 'fs'
import { tmpdir } from 'os'
import { join, dirname, basename } from 'path'
import JSZip from 'jszip'
import Papa from 'papaparse'
import ExcelJS from 'exceljs'
import type {
  ColumnMeta,
  DumpFormat,
  ExportFormat,
  ExportPayload,
  FileResult,
  ImportResult,
  IoProgress,
  TableDumpSpec,
  TableInfo,
  TransferMode,
  TransferResult
} from '@shared/types'
import { isSqlDriver, sqlDialect } from '@shared/types'

/** Progress reporter for a long export/transfer (opId is attached by the IPC layer). */
export type ProgressFn = (p: Omit<IoProgress, 'opId'>) => void

/** Thrown when a background op is cancelled; the renderer maps it to a 'canceled' task. */
export const CANCELED = 'Canceled'
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(CANCELED)
}

/** A hidden sibling of `finalPath` in the same directory — so the atomic rename
    that finalizes a download never crosses filesystems (which would not be atomic). */
function partPath(finalPath: string): string {
  return join(dirname(finalPath), `.${basename(finalPath)}.part`)
}

/** Write via a temp sibling, then atomically rename into place. The final-named
    file only appears once it is complete (no half-written, growing file). */
async function finalize(finalPath: string, write: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = partPath(finalPath)
  try {
    await write(tmp)
    await rename(tmp, finalPath)
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw e
  }
}
import type { MaskConfig } from '@shared/mask'
import { applyMasks, tableMasks } from './mask'
import { findCloneTools, nativeClone, nativeDump, killNativeChildren } from './nativeClone'
import { getAdapter } from '../db'

export { killNativeChildren }

/** Whether native dump/restore CLIs are present for a driver (for a UI hint). */
export async function nativeToolsAvailable(driver: string): Promise<boolean> {
  return (await findCloneTools(sqlDialect(driver))) !== null
}
import type { DbAdapter } from '../db/types'
import * as store from '../storage'
import type { Workspace } from '@shared/types'
import { buildCsv, buildInserts, buildJson, buildXlsx, csvCell, jsonObject, quoteIdent, type Dialect } from './format'

const EXT: Record<ExportFormat, string> = { csv: 'csv', json: 'json', xlsx: 'xlsx', sql: 'sql' }
// Rows fetched per page during a streamed dump. Kept modest so per-page buffers
// (rows + generated INSERT text) stay small and die young under GC.
const PAGE = 500

function dialectOf(connId: string): Dialect {
  try {
    return sqlDialect(getAdapter(connId).config.driver)
  } catch {
    return 'postgres'
  }
}

/**
 * Page through an entire table, invoking `onChunk` per batch (constant memory).
 * Prefers the adapter's streaming/keyset path (O(n)); only falls back to OFFSET
 * paging (O(n²) on large tables) for engines that don't implement streaming.
 */
async function pageThrough(
  adapter: DbAdapter,
  table: TableInfo,
  onChunk: (columns: ColumnMeta[], rows: unknown[][]) => Promise<void> | void
): Promise<void> {
  if (adapter.streamTableData) {
    await adapter.streamTableData(table, PAGE, async (columns, rows) => {
      await onChunk(columns, rows)
    })
    return
  }
  let offset = 0
  for (;;) {
    const r = await adapter.tableData(table, { limit: PAGE, offset })
    await onChunk(r.columns, r.rows)
    if (r.rows.length < PAGE) break
    offset += PAGE
  }
}

/** Sum the rows to be dumped across data-mode tables, for an accurate ETA/bar. */
async function countDumpRows(
  adapter: DbAdapter,
  specs: TableDumpSpec[],
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<number> {
  if (!adapter.countRows) return 0
  let total = 0
  for (const spec of specs) {
    if (spec.mode !== 'data' && spec.mode !== 'both') continue
    throwIfAborted(signal)
    onProgress?.({ phase: 'prepare', label: spec.name, current: 0, total: 0 })
    try {
      total += await adapter.countRows({ schema: spec.schema, name: spec.name, type: 'table' }, { limit: 0, offset: 0 })
    } catch {
      /* counting is best-effort; skip tables that fail */
    }
  }
  return total
}

function writer(stream: WriteStream): (s: string) => Promise<void> {
  return (s) =>
    new Promise<void>((resolve, reject) => stream.write(s, (e) => (e ? reject(e) : resolve())))
}

// ---- in-memory result export (query results) -------------------------------

async function renderPayload(
  format: ExportFormat,
  columns: ColumnMeta[],
  rows: unknown[][],
  tableName: string,
  dialect: Dialect
): Promise<string | Buffer> {
  switch (format) {
    case 'csv':
      return buildCsv(columns, rows)
    case 'json':
      return buildJson(columns, rows)
    case 'xlsx':
      return buildXlsx(columns, rows)
    case 'sql':
      return buildInserts(tableName, columns, rows, dialect)
  }
}

export async function exportData(
  connId: string,
  format: ExportFormat,
  payload: ExportPayload
): Promise<FileResult> {
  const base = payload.tableName || 'export'
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: `${base}.${EXT[format]}`,
    filters: [{ name: format.toUpperCase(), extensions: [EXT[format]] }]
  })
  if (canceled || !filePath) return { canceled: true }
  const data = await renderPayload(format, payload.columns, payload.rows, base, dialectOf(connId))
  await finalize(filePath, (out) => writeFile(out, data))
  return { canceled: false, path: filePath }
}

// ---- streaming single-table export ------------------------------------------

async function streamTable(
  adapter: DbAdapter,
  table: TableInfo,
  format: ExportFormat,
  dialect: Dialect,
  filePath: string
): Promise<void> {
  if (format === 'xlsx') {
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath })
    const ws = wb.addWorksheet('Export')
    let header = false
    await pageThrough(adapter, table, (columns, rows) => {
      if (!header) {
        ws.addRow(columns.map((c) => c.name)).commit()
        header = true
      }
      for (const r of rows) ws.addRow(r.map((v) => (v === null || v === undefined ? null : v))).commit()
    })
    await wb.commit()
    return
  }

  const out = createWriteStream(filePath, { encoding: 'utf-8' })
  const write = writer(out)
  try {
    if (format === 'csv') {
      let header = false
      await pageThrough(adapter, table, async (columns, rows) => {
        if (!header) {
          await write(columns.map((c) => csvCell(c.name)).join(',') + '\r\n')
          header = true
        }
        if (rows.length) await write(rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n')
      })
    } else if (format === 'json') {
      await write('[')
      let first = true
      await pageThrough(adapter, table, async (columns, rows) => {
        for (const r of rows) {
          await write((first ? '\n' : ',\n') + JSON.stringify(jsonObject(columns, r)))
          first = false
        }
      })
      await write('\n]')
    } else {
      await pageThrough(adapter, table, async (columns, rows) => {
        const ins = buildInserts(table.name, columns, rows, dialect)
        if (ins) await write(ins + '\n')
      })
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve))
  }
}

export async function exportTable(
  connId: string,
  table: TableInfo,
  format: ExportFormat
): Promise<FileResult> {
  const adapter = getAdapter(connId)
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: `${table.name}.${EXT[format]}`,
    filters: [{ name: format.toUpperCase(), extensions: [EXT[format]] }]
  })
  if (canceled || !filePath) return { canceled: true }
  await finalize(filePath, (out) => streamTable(adapter, table, format, adapter.config.driver, out))
  return { canceled: false, path: filePath }
}

// ---- streaming whole-database dump ------------------------------------------

async function streamDump(
  adapter: DbAdapter,
  specs: TableDumpSpec[],
  filePath: string,
  maskConfig?: MaskConfig,
  dropFirst = false,
  onProgress?: ProgressFn,
  totalRows = 0,
  signal?: AbortSignal
): Promise<void> {
  const dialect = sqlDialect(adapter.config.driver)
  const out = createWriteStream(filePath, { encoding: 'utf-8' })
  const write = writer(out)
  const masked = !!maskConfig && Object.keys(maskConfig).length > 0
  const total = specs.filter((s) => s.mode !== 'skip').length
  let done = 0
  let doneRows = 0
  const startedAt = Date.now()
  const eta = (): number | undefined => {
    if (!totalRows || doneRows === 0) return undefined
    const elapsed = Date.now() - startedAt
    return Math.max(0, Math.round((elapsed / doneRows) * (totalRows - doneRows)))
  }
  try {
    await write(`-- DataDock dump\n-- generated ${new Date().toISOString()}\n`)
    if (masked) await write('-- ⚠ anonymized: selected columns replaced with fake data\n')
    await write('\n')
    for (const spec of specs) {
      if (spec.mode === 'skip') continue
      throwIfAborted(signal)
      const table: TableInfo = { schema: spec.schema, name: spec.name, type: 'table' }
      onProgress?.({ phase: 'dump', label: spec.name, current: done, total, rows: 0, doneRows, totalRows, etaMs: eta() })
      await write(`-- ----------------------------\n-- ${spec.name}\n-- ----------------------------\n`)
      if ((spec.mode === 'structure' || spec.mode === 'both') && adapter.tableDDL) {
        if (dropFirst) await write(`DROP TABLE IF EXISTS ${quoteIdent(spec.name, dialect)};\n`)
        await write((await adapter.tableDDL(table)) + '\n\n')
      }
      if (spec.mode === 'data' || spec.mode === 'both') {
        const masks = tableMasks(maskConfig, spec.name)
        let rows = 0
        await pageThrough(adapter, table, async (columns, page) => {
          throwIfAborted(signal)
          const out = masks ? applyMasks(columns, page, masks) : page
          const ins = buildInserts(spec.name, columns, out, dialect)
          if (ins) await write(ins + '\n')
          rows += page.length
          doneRows += page.length
          onProgress?.({ phase: 'dump', label: spec.name, current: done, total, rows, doneRows, totalRows, etaMs: eta() })
        })
        await write('\n')
      }
      done++
    }
    onProgress?.({ phase: 'dump', label: '', current: done, total, rows: 0, doneRows, totalRows, etaMs: 0 })
  } finally {
    await new Promise<void>((resolve) => out.end(resolve))
  }
}

export async function exportDatabase(
  connId: string,
  specs: TableDumpSpec[],
  format: DumpFormat,
  maskConfig?: MaskConfig,
  dropTables = true,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
  opId?: string
): Promise<FileResult> {
  const adapter = getAdapter(connId)
  const dbName = adapter.config.database || adapter.config.name || 'database'
  const ext = format === 'sql-zip' ? 'zip' : 'sql'
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: `${dbName}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  })
  if (canceled || !filePath) return { canceled: true }

  const included = specs.filter((s) => s.mode !== 'skip')
  // Native dump CLI when available + unmasked; else the JS streaming dump.
  const tools = maskConfig ? null : await findCloneTools(sqlDialect(adapter.config.driver))

  const writeSql = async (dest: string): Promise<void> => {
    if (tools && included.length > 0) {
      await nativeDump(
        tools,
        adapter.config,
        {
          includeTables: included.map((s) => s.name),
          allIncluded: included.length === specs.length,
          // For a dump (no restore step) replace vs merge only governs whether
          // DROP TABLE IF EXISTS is emitted.
          mode: dropTables ? 'replace' : 'merge',
          structureOnly: included.every((s) => s.mode === 'structure'),
          dataOnly: included.every((s) => s.mode === 'data')
        },
        dest,
        onProgress,
        signal,
        opId
      )
    } else {
      const totalRows = await countDumpRows(adapter, specs, onProgress, signal)
      await streamDump(adapter, specs, dest, maskConfig, dropTables, onProgress, totalRows, signal)
    }
  }

  if (format === 'sql-zip') {
    const tmp = join(tmpdir(), `datadock-${Date.now()}.sql`)
    try {
      await writeSql(tmp)
      await finalize(filePath, (out) => {
        const zip = new JSZip()
        zip.file(`${dbName}.sql`, createReadStream(tmp))
        return new Promise<void>((resolve, reject) => {
          zip
            .generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' })
            .pipe(createWriteStream(out))
            .on('finish', () => resolve())
            .on('error', reject)
        })
      })
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  } else {
    await finalize(filePath, (out) => writeSql(out))
  }
  return { canceled: false, path: filePath }
}

// ---- snapshots (full dump to a managed path + replay) -----------------------

/** Dump every base table (structure + data) to a path, with DROP IF EXISTS so
    the script can be replayed onto an existing database. Returns table count. */
export async function dumpDatabaseToFile(
  connId: string,
  filePath: string,
  dropFirst = false
): Promise<{ tableCount: number }> {
  const adapter = getAdapter(connId)
  const tables = (await adapter.listTables()).filter((t) => t.type === 'table')
  const specs: TableDumpSpec[] = tables.map((t) => ({ schema: t.schema, name: t.name, mode: 'both' }))
  await streamDump(adapter, specs, filePath, undefined, dropFirst)
  return { tableCount: tables.length }
}

/**
 * Copy a database onto another connection: dump the source to a temp .sql file
 * and replay it against the target. `replace` mode prefixes each table with
 * DROP TABLE IF EXISTS for a clean restore; `merge` leaves the target intact.
 * Restricted to SQL engines that share a dialect (the dump speaks the source's).
 */
export async function transferDatabase(
  sourceId: string,
  targetId: string,
  specs: TableDumpSpec[],
  mode: TransferMode,
  maskConfig?: MaskConfig,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
  opId?: string
): Promise<TransferResult> {
  if (sourceId === targetId) throw new Error('Source and target must be different connections')
  const source = getAdapter(sourceId)
  const target = getAdapter(targetId)
  if (!isSqlDriver(source.config.driver) || !isSqlDriver(target.config.driver))
    throw new Error('Transfer is only supported between SQL databases')
  if (sqlDialect(source.config.driver) !== sqlDialect(target.config.driver))
    throw new Error(
      `Incompatible engines: cannot transfer ${source.config.driver} → ${target.config.driver}`
    )

  const included = specs.filter((s) => s.mode !== 'skip')

  // Prefer the engine's native dump/restore CLIs — they stream entirely outside
  // V8 (no OOM on huge clones) and handle escaping/charset/FK ordering. Masked
  // transfers need our JS masker, so those fall back to the streaming path.
  const tools = maskConfig ? null : await findCloneTools(sqlDialect(source.config.driver))
  if (tools && included.length > 0) {
    await nativeClone(
      tools,
      source.config,
      target.config,
      {
        includeTables: included.map((s) => s.name),
        allIncluded: included.length === specs.length,
        mode,
        structureOnly: included.every((s) => s.mode === 'structure'),
        dataOnly: included.every((s) => s.mode === 'data')
      },
      onProgress,
      signal,
      opId
    )
    return { tableCount: included.length, statements: 0, errors: [] }
  }

  const tmp = join(tmpdir(), `datadock-transfer-${Date.now()}.sql`)
  try {
    const totalRows = await countDumpRows(source, specs, onProgress, signal)
    await streamDump(source, specs, tmp, maskConfig, mode === 'replace', onProgress, totalRows, signal)
    const res = await runSqlFile(targetId, tmp, onProgress, signal)
    return {
      tableCount: included.length,
      statements: res.statements ?? 0,
      errors: res.errors
    }
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
}

/** Run every statement in a .sql file against a connection (used by restore/clone). */
export async function runSqlFile(
  connId: string,
  filePath: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<ImportResult> {
  return execSqlFile(getAdapter(connId), filePath, onProgress, signal)
}

// ---- share connections ------------------------------------------------------

export async function exportConnections(): Promise<FileResult> {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: 'datadock-connections.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (canceled || !filePath) return { canceled: true }
  await writeFile(filePath, JSON.stringify(store.connectionsForExport(), null, 2))
  return { canceled: false, path: filePath }
}

export async function importConnections(): Promise<{ canceled?: boolean; workspace?: Workspace }> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (canceled || !filePaths[0]) return { canceled: true }
  const data = JSON.parse(await readFile(filePaths[0], 'utf-8'))
  return { workspace: store.importConnections(data) }
}

/** Save arbitrary text or base64-binary content via a save dialog. */
export async function saveFile(defaultName: string, data: string, binary: boolean): Promise<FileResult> {
  const ext = defaultName.split('.').pop() || 'txt'
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  })
  if (canceled || !filePath) return { canceled: true }
  await writeFile(filePath, binary ? Buffer.from(data, 'base64') : data)
  return { canceled: false, path: filePath }
}

/**
 * Render a self-contained HTML document (the renderer composes it with chart
 * images already embedded as data-URLs) to a PDF in an offscreen window. Used
 * for dashboard/report export. No external print dependency required.
 */
export async function exportHtmlToPdf(
  defaultName: string,
  html: string,
  landscape = true
): Promise<FileResult> {
  const name = defaultName.endsWith('.pdf') ? defaultName : `${defaultName}.pdf`
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: name,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (canceled || !filePath) return { canceled: true }

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { offscreen: true, sandbox: true }
  })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    // Give embedded images/fonts a tick to settle before printing.
    await new Promise((r) => setTimeout(r, 250))
    const pdf = await win.webContents.printToPDF({
      landscape,
      printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
    })
    await writeFile(filePath, pdf)
  } finally {
    win.destroy()
  }
  return { canceled: false, path: filePath }
}

/** Pick a destination folder (for scheduled report output). */
export async function pickFolder(): Promise<FileResult> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  })
  if (canceled || !filePaths[0]) return { canceled: true }
  return { canceled: false, path: filePaths[0] }
}

// ---- import -----------------------------------------------------------------

/**
 * Incremental SQL statement splitter. Fed file chunks, it emits complete
 * statements as their terminating `;` is seen — so we never hold the whole
 * (potentially multi-GB) script in memory. Respects single/double quotes,
 * line (`--`) and block (`/* *\/`) comments across chunk boundaries by carrying
 * the trailing char (which may need one-char lookahead) into the next chunk.
 */
class SqlSplitter {
  private buf = ''
  private carry = ''
  private inSingle = false
  private inDouble = false
  private inLine = false
  private inBlock = false
  private skipNext = false

  private process(s: string, hasMore: boolean): string[] {
    const out: string[] = []
    const end = hasMore ? s.length - 1 : s.length
    for (let i = 0; i < end; i++) {
      const ch = s[i]
      const next = s[i + 1]
      if (this.skipNext) {
        this.skipNext = false
        continue
      }
      if (this.inLine) {
        if (ch === '\n') this.inLine = false
        continue
      }
      if (this.inBlock) {
        if (ch === '*' && next === '/') {
          this.inBlock = false
          this.skipNext = true
        }
        continue
      }
      if (!this.inSingle && !this.inDouble) {
        if (ch === '-' && next === '-') {
          this.inLine = true
          continue
        }
        if (ch === '/' && next === '*') {
          this.inBlock = true
          this.skipNext = true
          continue
        }
      }
      if (ch === "'" && !this.inDouble) this.inSingle = !this.inSingle
      else if (ch === '"' && !this.inSingle) this.inDouble = !this.inDouble

      if (ch === ';' && !this.inSingle && !this.inDouble) {
        const t = this.buf.trim()
        if (t) out.push(t)
        this.buf = ''
      } else {
        this.buf += ch
      }
    }
    this.carry = hasMore ? s.slice(end) : ''
    return out
  }

  feed(chunk: string): string[] {
    return this.process(this.carry + chunk, true)
  }

  /** Flush the trailing buffer (a final statement without a `;`). */
  end(): string[] {
    const out = this.process(this.carry, false)
    const t = this.buf.trim()
    if (t) out.push(t)
    this.buf = ''
    return out
  }
}

/**
 * Stream a .sql file and execute each statement as it completes. Progress is
 * reported by bytes read (the statement count isn't known without a full read).
 */
async function execSqlFile(
  adapter: DbAdapter,
  filePath: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<ImportResult> {
  const { size } = await stat(filePath)
  const splitter = new SqlSplitter()
  let ran = 0
  let bytesRead = 0
  let lastEmit = 0
  const errors: string[] = []

  const run = async (stmt: string): Promise<void> => {
    throwIfAborted(signal)
    try {
      await adapter.query(stmt)
      ran++
    } catch (e) {
      errors.push(`${e instanceof Error ? e.message : String(e)} — near: ${stmt.slice(0, 60)}…`)
    }
  }

  const stream = createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 1 << 20 })
  for await (const chunk of stream) {
    bytesRead += Buffer.byteLength(chunk as string, 'utf-8')
    for (const stmt of splitter.feed(chunk as string)) await run(stmt)
    if (onProgress && Date.now() - lastEmit > 100) {
      onProgress({ phase: 'import', label: 'Importing into target', current: bytesRead, total: size })
      lastEmit = Date.now()
    }
  }
  for (const stmt of splitter.end()) await run(stmt)
  onProgress?.({ phase: 'import', label: 'Importing into target', current: size, total: size })

  return { statements: ran, errors }
}

export async function importSql(connId: string): Promise<ImportResult & { canceled?: boolean }> {
  const adapter = getAdapter(connId)
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'SQL', extensions: ['sql'] }]
  })
  if (canceled || !filePaths[0]) return { canceled: true, statements: 0, errors: [] }
  return execSqlFile(adapter, filePaths[0])
}

export async function importCsv(
  connId: string,
  table: TableInfo
): Promise<ImportResult & { canceled?: boolean }> {
  const adapter = getAdapter(connId)
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  })
  if (canceled || !filePaths[0]) return { canceled: true, rowsInserted: 0, errors: [] }

  const text = await readFile(filePaths[0], 'utf-8')
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true })
  const fields = parsed.meta.fields ?? []
  if (fields.length === 0) return { rowsInserted: 0, errors: ['No columns found in CSV header'] }

  const columns: ColumnMeta[] = fields.map((name) => ({ name }))
  const rows = parsed.data.map((obj) =>
    fields.map((f) => (obj[f] === '' || obj[f] == null ? null : obj[f]))
  )

  const dialect = sqlDialect(adapter.config.driver)
  const batchSize = 200
  let inserted = 0
  const errors: string[] = []
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const stmt = buildInserts(table.name, columns, batch, dialect, batchSize)
    try {
      await adapter.query(stmt)
      inserted += batch.length
    } catch (e) {
      errors.push(`Rows ${i + 1}–${i + batch.length}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { rowsInserted: inserted, errors }
}
