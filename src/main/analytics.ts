import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import type {
  AnalyticsChart,
  AnalyticsDashboard,
  AnalyticsDataset,
  AnalyticsMetric,
  ScheduledReport
} from '@shared/types'

interface Store {
  datasets: AnalyticsDataset[]
  metrics: AnalyticsMetric[]
  charts: AnalyticsChart[]
  dashboards: AnalyticsDashboard[]
  reports: ScheduledReport[]
}

let store: Store = { datasets: [], metrics: [], charts: [], dashboards: [], reports: [] }
let loaded = false
let path = ''

function file(): string {
  if (!path) path = join(app.getPath('userData'), 'analytics.json')
  return path
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf-8'))
      store = {
        datasets: Array.isArray(parsed?.datasets) ? parsed.datasets : [],
        metrics: Array.isArray(parsed?.metrics) ? parsed.metrics : [],
        charts: Array.isArray(parsed?.charts) ? parsed.charts : [],
        dashboards: Array.isArray(parsed?.dashboards) ? parsed.dashboards : [],
        reports: Array.isArray(parsed?.reports) ? parsed.reports : []
      }
    }
  } catch {
    store = { datasets: [], metrics: [], charts: [], dashboards: [], reports: [] }
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(store, null, 2), 'utf-8')
  } catch {
    /* best effort */
  }
}

// ---- datasets --------------------------------------------------------------

export function listDatasets(connectionId: string): AnalyticsDataset[] {
  load()
  return store.datasets
    .filter((d) => d.connectionId === connectionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function saveDataset(
  input: Partial<AnalyticsDataset> & Pick<AnalyticsDataset, 'connectionId' | 'name' | 'source'>
): AnalyticsDataset {
  load()
  const now = new Date().toISOString()
  const existing = input.id ? store.datasets.find((d) => d.id === input.id) : undefined
  if (existing) {
    Object.assign(existing, { name: input.name, source: input.source, updatedAt: now })
    persist()
    return existing
  }
  const dataset: AnalyticsDataset = {
    id: randomUUID(),
    connectionId: input.connectionId,
    name: input.name,
    source: input.source,
    createdAt: now,
    updatedAt: now
  }
  store.datasets.push(dataset)
  persist()
  return dataset
}

export function removeDataset(id: string): void {
  load()
  store.datasets = store.datasets.filter((d) => d.id !== id)
  // Cascade: drop metrics + charts that referenced this dataset, and any
  // dashboard widgets that referenced those charts.
  store.metrics = store.metrics.filter((m) => m.datasetId !== id)
  const droppedCharts = new Set(store.charts.filter((c) => c.datasetId === id).map((c) => c.id))
  store.charts = store.charts.filter((c) => c.datasetId !== id)
  dropWidgets(droppedCharts)
  persist()
}

// ---- metrics ---------------------------------------------------------------

export function listMetrics(connectionId: string): AnalyticsMetric[] {
  load()
  return store.metrics
    .filter((m) => m.connectionId === connectionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function saveMetric(
  input: Partial<AnalyticsMetric> &
    Pick<AnalyticsMetric, 'connectionId' | 'datasetId' | 'name' | 'agg'>
): AnalyticsMetric {
  load()
  const now = new Date().toISOString()
  const existing = input.id ? store.metrics.find((m) => m.id === input.id) : undefined
  if (existing) {
    Object.assign(existing, {
      datasetId: input.datasetId,
      name: input.name,
      agg: input.agg,
      column: input.column,
      filters: input.filters,
      format: input.format,
      icon: input.icon,
      updatedAt: now
    })
    persist()
    return existing
  }
  const metric: AnalyticsMetric = {
    id: randomUUID(),
    connectionId: input.connectionId,
    datasetId: input.datasetId,
    name: input.name,
    agg: input.agg,
    column: input.column,
    filters: input.filters,
    format: input.format,
    icon: input.icon,
    createdAt: now,
    updatedAt: now
  }
  store.metrics.push(metric)
  persist()
  return metric
}

export function removeMetric(id: string): void {
  load()
  store.metrics = store.metrics.filter((m) => m.id !== id)
  // Charts bound to this metric keep their own fallback encoding, so just unbind.
  for (const c of store.charts) {
    if (c.encoding?.metricId === id) delete c.encoding.metricId
  }
  persist()
}

function dropWidgets(chartIds: Set<string>): void {
  if (!chartIds.size) return
  for (const d of store.dashboards) {
    d.widgets = d.widgets.filter((w) => !chartIds.has(w.chartId))
  }
}

// ---- charts ----------------------------------------------------------------

export function listCharts(connectionId: string): AnalyticsChart[] {
  load()
  return store.charts
    .filter((c) => c.connectionId === connectionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function saveChart(
  input: Partial<AnalyticsChart> &
    Pick<AnalyticsChart, 'connectionId' | 'datasetId' | 'name' | 'type' | 'encoding'>
): AnalyticsChart {
  load()
  const now = new Date().toISOString()
  const existing = input.id ? store.charts.find((c) => c.id === input.id) : undefined
  if (existing) {
    Object.assign(existing, {
      datasetId: input.datasetId,
      name: input.name,
      type: input.type,
      encoding: input.encoding,
      icon: input.icon,
      updatedAt: now
    })
    persist()
    return existing
  }
  const chart: AnalyticsChart = {
    id: randomUUID(),
    connectionId: input.connectionId,
    datasetId: input.datasetId,
    name: input.name,
    type: input.type,
    encoding: input.encoding,
    icon: input.icon,
    createdAt: now,
    updatedAt: now
  }
  store.charts.push(chart)
  persist()
  return chart
}

export function removeChart(id: string): void {
  load()
  store.charts = store.charts.filter((c) => c.id !== id)
  dropWidgets(new Set([id]))
  persist()
}

// ---- dashboards ------------------------------------------------------------

export function listDashboards(connectionId: string): AnalyticsDashboard[] {
  load()
  return store.dashboards
    .filter((d) => d.connectionId === connectionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function saveDashboard(
  input: Partial<AnalyticsDashboard> &
    Pick<AnalyticsDashboard, 'connectionId' | 'name' | 'widgets'>
): AnalyticsDashboard {
  load()
  const now = new Date().toISOString()
  const existing = input.id ? store.dashboards.find((d) => d.id === input.id) : undefined
  if (existing) {
    Object.assign(existing, { name: input.name, widgets: input.widgets, updatedAt: now })
    persist()
    return existing
  }
  const dashboard: AnalyticsDashboard = {
    id: randomUUID(),
    connectionId: input.connectionId,
    name: input.name,
    widgets: input.widgets,
    createdAt: now,
    updatedAt: now
  }
  store.dashboards.push(dashboard)
  persist()
  return dashboard
}

export function removeDashboard(id: string): void {
  load()
  store.dashboards = store.dashboards.filter((d) => d.id !== id)
  // Cascade: drop scheduled reports that targeted this dashboard.
  store.reports = store.reports.filter((r) => r.dashboardId !== id)
  persist()
}

// ---- by-id accessors (used by the report scheduler) ------------------------

export function findDashboard(id: string): AnalyticsDashboard | undefined {
  load()
  return store.dashboards.find((d) => d.id === id)
}
export function findChart(id: string): AnalyticsChart | undefined {
  load()
  return store.charts.find((c) => c.id === id)
}
export function findDataset(id: string): AnalyticsDataset | undefined {
  load()
  return store.datasets.find((d) => d.id === id)
}
export function findMetric(id: string): AnalyticsMetric | undefined {
  load()
  return store.metrics.find((m) => m.id === id)
}

// ---- scheduled reports -----------------------------------------------------

export function listReports(connectionId: string): ScheduledReport[] {
  load()
  return store.reports
    .filter((r) => r.connectionId === connectionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function listAllReports(): ScheduledReport[] {
  load()
  return store.reports
}

export function findReport(id: string): ScheduledReport | undefined {
  load()
  return store.reports.find((r) => r.id === id)
}

export function saveReport(
  input: Partial<ScheduledReport> &
    Pick<ScheduledReport, 'connectionId' | 'name' | 'dashboardId' | 'folder' | 'everyMinutes'>
): ScheduledReport {
  load()
  const now = new Date().toISOString()
  const next = new Date(Date.now() + Math.max(1, input.everyMinutes) * 60_000).toISOString()
  const existing = input.id ? store.reports.find((r) => r.id === input.id) : undefined
  if (existing) {
    Object.assign(existing, {
      name: input.name,
      dashboardId: input.dashboardId,
      format: input.format ?? 'xlsx',
      folder: input.folder,
      everyMinutes: input.everyMinutes,
      enabled: input.enabled ?? existing.enabled,
      // Reschedule from now whenever the report is edited.
      nextRunAt: next,
      updatedAt: now
    })
    persist()
    return existing
  }
  const report: ScheduledReport = {
    id: randomUUID(),
    connectionId: input.connectionId,
    name: input.name,
    dashboardId: input.dashboardId,
    format: input.format ?? 'xlsx',
    folder: input.folder,
    everyMinutes: input.everyMinutes,
    enabled: input.enabled ?? true,
    nextRunAt: next,
    createdAt: now,
    updatedAt: now
  }
  store.reports.push(report)
  persist()
  return report
}

export function removeReport(id: string): void {
  load()
  store.reports = store.reports.filter((r) => r.id !== id)
  persist()
}

/** Record the outcome of a scheduler run (does not touch user-edited fields). */
export function setReportRun(
  id: string,
  patch: { lastRunAt: string; nextRunAt: string; lastStatus: string }
): void {
  load()
  const r = store.reports.find((x) => x.id === id)
  if (!r) return
  r.lastRunAt = patch.lastRunAt
  r.nextRunAt = patch.nextRunAt
  r.lastStatus = patch.lastStatus
  persist()
}
