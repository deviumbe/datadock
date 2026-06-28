import { dialog, BrowserWindow } from 'electron'
import { writeFile, readFile, unlink } from 'fs/promises'
import { createWriteStream, createReadStream, type WriteStream } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
  TableDumpSpec,
  TableInfo
} from '@shared/types'
import { sqlDialect } from '@shared/types'
import type { MaskConfig } from '@shared/mask'
import { applyMasks, tableMasks } from './mask'
import { getAdapter } from '../db'
import type { DbAdapter } from '../db/types'
import * as store from '../storage'
import type { Workspace } from '@shared/types'
import { buildCsv, buildInserts, buildJson, buildXlsx, csvCell, jsonObject, quoteIdent, type Dialect } from './format'

const EXT: Record<ExportFormat, string> = { csv: 'csv', json: 'json', xlsx: 'xlsx', sql: 'sql' }
const PAGE = 2000

function dialectOf(connId: string): Dialect {
  try {
    return sqlDialect(getAdapter(connId).config.driver)
  } catch {
    return 'postgres'
  }
}

/** Page through an entire table, invoking `onChunk` per batch (constant memory). */
async function pageThrough(
  adapter: DbAdapter,
  table: TableInfo,
  onChunk: (columns: ColumnMeta[], rows: unknown[][]) => Promise<void> | void
): Promise<void> {
  let offset = 0
  for (;;) {
    const r = await adapter.tableData(table, { limit: PAGE, offset })
    await onChunk(r.columns, r.rows)
    if (r.rows.length < PAGE) break
    offset += PAGE
  }
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
  await writeFile(filePath, data)
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
  await streamTable(adapter, table, format, adapter.config.driver, filePath)
  return { canceled: false, path: filePath }
}

// ---- streaming whole-database dump ------------------------------------------

async function streamDump(
  adapter: DbAdapter,
  specs: TableDumpSpec[],
  filePath: string,
  maskConfig?: MaskConfig,
  dropFirst = false
): Promise<void> {
  const dialect = sqlDialect(adapter.config.driver)
  const out = createWriteStream(filePath, { encoding: 'utf-8' })
  const write = writer(out)
  const masked = !!maskConfig && Object.keys(maskConfig).length > 0
  try {
    await write(`-- DataDock dump\n-- generated ${new Date().toISOString()}\n`)
    if (masked) await write('-- ⚠ anonymized: selected columns replaced with fake data\n')
    await write('\n')
    for (const spec of specs) {
      if (spec.mode === 'skip') continue
      const table: TableInfo = { schema: spec.schema, name: spec.name, type: 'table' }
      await write(`-- ----------------------------\n-- ${spec.name}\n-- ----------------------------\n`)
      if ((spec.mode === 'structure' || spec.mode === 'both') && adapter.tableDDL) {
        if (dropFirst) await write(`DROP TABLE IF EXISTS ${quoteIdent(spec.name, dialect)};\n`)
        await write((await adapter.tableDDL(table)) + '\n\n')
      }
      if (spec.mode === 'data' || spec.mode === 'both') {
        const masks = tableMasks(maskConfig, spec.name)
        await pageThrough(adapter, table, async (columns, rows) => {
          const out = masks ? applyMasks(columns, rows, masks) : rows
          const ins = buildInserts(spec.name, columns, out, dialect)
          if (ins) await write(ins + '\n')
        })
        await write('\n')
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve))
  }
}

export async function exportDatabase(
  connId: string,
  specs: TableDumpSpec[],
  format: DumpFormat,
  maskConfig?: MaskConfig
): Promise<FileResult> {
  const adapter = getAdapter(connId)
  const dbName = adapter.config.database || adapter.config.name || 'database'
  const ext = format === 'sql-zip' ? 'zip' : 'sql'
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: `${dbName}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  })
  if (canceled || !filePath) return { canceled: true }

  if (format === 'sql-zip') {
    const tmp = join(tmpdir(), `datadock-${Date.now()}.sql`)
    await streamDump(adapter, specs, tmp, maskConfig)
    const zip = new JSZip()
    zip.file(`${dbName}.sql`, createReadStream(tmp))
    await new Promise<void>((resolve, reject) => {
      zip
        .generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' })
        .pipe(createWriteStream(filePath))
        .on('finish', () => resolve())
        .on('error', reject)
    })
    await unlink(tmp).catch(() => undefined)
  } else {
    await streamDump(adapter, specs, filePath, maskConfig)
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

/** Run every statement in a .sql file against a connection (used by restore). */
export async function runSqlFile(connId: string, filePath: string): Promise<ImportResult> {
  const adapter = getAdapter(connId)
  const text = await readFile(filePath, 'utf-8')
  const statements = splitStatements(text)
  let ran = 0
  const errors: string[] = []
  for (const stmt of statements) {
    try {
      await adapter.query(stmt)
      ran++
    } catch (e) {
      errors.push(`${e instanceof Error ? e.message : String(e)} — near: ${stmt.slice(0, 60)}…`)
    }
  }
  return { statements: ran, errors }
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

/** Split a SQL script into statements, respecting quotes and comments. */
function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (!inSingle && !inDouble) {
      if (ch === '-' && next === '-') {
        while (i < sql.length && sql[i] !== '\n') i++
        continue
      }
      if (ch === '/' && next === '*') {
        i += 2
        while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
        i++
        continue
      }
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble

    if (ch === ';' && !inSingle && !inDouble) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

export async function importSql(connId: string): Promise<ImportResult & { canceled?: boolean }> {
  const adapter = getAdapter(connId)
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'SQL', extensions: ['sql'] }]
  })
  if (canceled || !filePaths[0]) return { canceled: true, statements: 0, errors: [] }

  const text = await readFile(filePaths[0], 'utf-8')
  const statements = splitStatements(text)
  let ran = 0
  const errors: string[] = []
  for (const stmt of statements) {
    try {
      await adapter.query(stmt)
      ran++
    } catch (e) {
      errors.push(`${e instanceof Error ? e.message : String(e)} — near: ${stmt.slice(0, 60)}…`)
    }
  }
  return { statements: ran, errors }
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
