// Background scheduler for analytics reports. Every minute it checks for due
// reports and exports the target dashboard's data to an Excel workbook (one
// worksheet per chart) in the configured folder. Runs headlessly — it queries
// through the live connection adapter, so a report only runs while DataDock is
// open and that connection is active.
import { Notification } from 'electron'
import { join } from 'path'
import ExcelJS from 'exceljs'
import type { ChartEncoding, ScheduledReport } from '@shared/types'
import * as analytics from './analytics'
import { getAdapter } from './db'
import { buildChartSql, datasetRowsSql } from './analyticsQuery'

let timer: ReturnType<typeof setInterval> | null = null

export function startScheduler(): void {
  if (timer) return
  // First sweep shortly after startup, then once a minute.
  setTimeout(() => void tick(), 15_000)
  timer = setInterval(() => void tick(), 60_000)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function tick(): Promise<void> {
  const now = Date.now()
  for (const r of analytics.listAllReports()) {
    if (!r.enabled) continue
    const due = r.nextRunAt ? Date.parse(r.nextRunAt) : now
    if (now >= due) await runReport(r.id).catch(() => undefined)
  }
}

/** Resolve a chart encoding through its saved metric (main-side mirror). */
function resolveEncoding(encoding: ChartEncoding): ChartEncoding {
  const m = encoding.metricId ? analytics.findMetric(encoding.metricId) : undefined
  if (!m) return encoding
  return {
    ...encoding,
    yAgg: m.agg,
    yColumn: m.column,
    filters: [...(m.filters ?? []), ...(encoding.filters ?? [])]
  }
}

function safeName(s: string): string {
  return s.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'report'
}
function sheetName(name: string, used: Set<string>): string {
  // Excel: max 31 chars, no []:*?/\ and must be unique.
  let base = (name || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Sheet'
  let candidate = base
  let n = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base.slice(0, 25)} ${n++}`
  }
  used.add(candidate.toLowerCase())
  return candidate
}
function stamp(): string {
  return new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '')
}

async function generate(r: ScheduledReport): Promise<string> {
  const dash = analytics.findDashboard(r.dashboardId)
  if (!dash) throw new Error('Dashboard no longer exists')
  // Throws if the connection isn't currently open.
  const adapter = getAdapter(r.connectionId)
  const driver = adapter.config.driver

  const wb = new ExcelJS.Workbook()
  wb.creator = 'DataDock'
  wb.created = new Date()

  const used = new Set<string>()
  let sheets = 0
  for (const w of dash.widgets) {
    const chart = analytics.findChart(w.chartId)
    if (!chart) continue
    const ds = analytics.findDataset(chart.datasetId)
    if (!ds) continue
    const enc = resolveEncoding(chart.encoding)
    const sql =
      chart.type === 'table'
        ? datasetRowsSql(driver, ds.source)
        : buildChartSql(driver, ds.source, enc)
    const res = await adapter.query(sql)
    const ws = wb.addWorksheet(sheetName(chart.name, used))
    ws.addRow(res.columns.map((c) => c.name))
    ws.getRow(1).font = { bold: true }
    for (const row of res.rows) {
      ws.addRow(row.map((v) => (v === null || v === undefined ? null : (v as ExcelJS.CellValue))))
    }
    sheets++
  }
  if (!sheets) {
    wb.addWorksheet('Empty').addRow(['This dashboard has no chart widgets.'])
  }

  const file = join(r.folder, `${safeName(r.name)}-${stamp()}.xlsx`)
  await wb.xlsx.writeFile(file)
  return file
}

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch {
    /* best effort */
  }
}

/** Run a report now (also used by the "Run now" button). Never throws. */
export async function runReport(id: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const r = analytics.findReport(id)
  if (!r) return { ok: false, error: 'Report not found' }
  const now = new Date().toISOString()
  const next = new Date(Date.now() + Math.max(1, r.everyMinutes) * 60_000).toISOString()
  try {
    const path = await generate(r)
    analytics.setReportRun(id, { lastRunAt: now, nextRunAt: next, lastStatus: 'OK' })
    notify('Report ready', `${r.name} → ${path}`)
    return { ok: true, path }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    analytics.setReportRun(id, { lastRunAt: now, nextRunAt: next, lastStatus: `Error: ${msg}` })
    notify('Report failed', `${r.name}: ${msg}`)
    return { ok: false, error: msg }
  }
}
