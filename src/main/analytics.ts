import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import type { AnalyticsChart, AnalyticsDashboard, AnalyticsDataset } from '@shared/types'

interface Store {
  datasets: AnalyticsDataset[]
  charts: AnalyticsChart[]
  dashboards: AnalyticsDashboard[]
}

let store: Store = { datasets: [], charts: [], dashboards: [] }
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
        charts: Array.isArray(parsed?.charts) ? parsed.charts : [],
        dashboards: Array.isArray(parsed?.dashboards) ? parsed.dashboards : []
      }
    }
  } catch {
    store = { datasets: [], charts: [], dashboards: [] }
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
  // Cascade: drop charts that referenced this dataset, and any dashboard
  // widgets that referenced those charts.
  const droppedCharts = new Set(store.charts.filter((c) => c.datasetId === id).map((c) => c.id))
  store.charts = store.charts.filter((c) => c.datasetId !== id)
  dropWidgets(droppedCharts)
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
  persist()
}
