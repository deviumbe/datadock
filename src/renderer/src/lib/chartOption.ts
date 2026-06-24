// Map query results into ECharts options. Saved-chart queries return columns
// named `x`, optional `series`, and `y`; instant-viz works off any result via
// auto-detection. Colours are read from the active theme's CSS variables.
import type { EChartsCoreOption } from 'echarts'
import type { ChartType, QueryResult } from '@shared/types'

const PALETTE = [
  '#3fcf8e', '#5b8def', '#e0a14a', '#e4646a', '#8b5cf6',
  '#1fb6a6', '#f59e0b', '#ec4899', '#22d3ee', '#a3e635'
]

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}
function palette(): { text: string; dim: string; border: string } {
  return {
    text: cssVar('--text', '#e6e6e6'),
    dim: cssVar('--text-faint', '#8a8f98'),
    border: cssVar('--border', '#2a2f3a')
  }
}

function idx(result: QueryResult, name: string): number {
  return result.columns.findIndex((c) => c.name === name)
}
function num(v: unknown): number {
  if (typeof v === 'number') return v
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}
function looksNumeric(result: QueryResult, ci: number): boolean {
  const sample = result.rows.slice(0, 25)
  if (!sample.length) return false
  return sample.every((r) => {
    const v = r[ci]
    if (v === null || v === undefined) return true
    const s = String(v).trim()
    return s !== '' && Number.isFinite(Number(s))
  })
}

function baseAxisType(type: ChartType): 'bar' | 'line' {
  return type === 'line' || type === 'area' ? 'line' : 'bar'
}

function cartesian(
  categories: string[],
  series: Record<string, unknown>[],
  horizontal: boolean
): EChartsCoreOption {
  const c = palette()
  const cat = { type: 'category' as const, data: categories, axisLabel: { color: c.dim }, axisLine: { lineStyle: { color: c.border } } }
  const val = { type: 'value' as const, axisLabel: { color: c.dim }, splitLine: { lineStyle: { color: c.border } } }
  return {
    color: PALETTE,
    grid: { left: 12, right: 18, top: series.length > 1 ? 40 : 18, bottom: 12, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: series.length > 1 ? { textStyle: { color: c.dim }, top: 6 } : undefined,
    xAxis: horizontal ? val : cat,
    yAxis: horizontal ? cat : val,
    series
  }
}

function pie(data: { name: string; value: number }[], donut: boolean): EChartsCoreOption {
  const c = palette()
  return {
    color: PALETTE,
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { type: 'scroll', orient: 'vertical', right: 8, top: 'middle', textStyle: { color: c.dim } },
    series: [
      {
        type: 'pie',
        radius: donut ? ['45%', '70%'] : '70%',
        center: ['40%', '52%'],
        label: { color: c.text },
        data
      }
    ]
  }
}

/** Build an option for a saved chart whose result has x/[series]/y columns. */
export function optionForChart(type: ChartType, result: QueryResult): EChartsCoreOption | null {
  const xi = idx(result, 'x')
  const si = idx(result, 'series')
  const yi = idx(result, 'y')
  if (yi < 0 || !result.rows.length) return null

  if (type === 'pie' || type === 'donut') {
    if (xi < 0) return null
    const data = result.rows.map((r) => ({ name: String(r[xi] ?? ''), value: num(r[yi]) }))
    return pie(data, type === 'donut')
  }

  if (xi < 0) return null
  const cats = [...new Set(result.rows.map((r) => String(r[xi] ?? '')))]
  const t = baseAxisType(type)
  let series: Record<string, unknown>[]
  if (si >= 0) {
    const names = [...new Set(result.rows.map((r) => String(r[si] ?? '')))]
    const grid = new Map<string, Map<string, number>>()
    for (const r of result.rows) {
      const s = String(r[si] ?? '')
      if (!grid.has(s)) grid.set(s, new Map())
      grid.get(s)!.set(String(r[xi] ?? ''), num(r[yi]))
    }
    series = names.map((n) => ({
      name: n,
      type: t,
      smooth: type === 'line' || type === 'area',
      areaStyle: type === 'area' ? {} : undefined,
      data: cats.map((cat) => grid.get(n)?.get(cat) ?? 0)
    }))
  } else {
    const m = new Map(result.rows.map((r) => [String(r[xi] ?? ''), num(r[yi])]))
    series = [
      {
        type: t,
        smooth: type === 'line' || type === 'area',
        areaStyle: type === 'area' ? {} : undefined,
        data: cats.map((cat) => m.get(cat) ?? 0)
      }
    ]
  }
  return cartesian(cats, series, type === 'hbar')
}

/** The single aggregate value behind a KPI chart. */
export function kpiValue(result: QueryResult): number | null {
  const yi = idx(result, 'y')
  const i = yi >= 0 ? yi : 0
  if (!result.rows.length) return null
  return num(result.rows[0][i])
}

export interface AutoDetect {
  xIndex: number
  yIndices: number[]
  type: ChartType
}
/** Guess sensible X (category/time) and Y (numeric) columns for any result. */
export function autoDetect(result: QueryResult): AutoDetect {
  const numeric = result.columns.map((_, ci) => looksNumeric(result, ci))
  let xIndex = result.columns.findIndex((_, ci) => !numeric[ci])
  if (xIndex < 0) xIndex = 0
  const yIndices = result.columns.map((_, ci) => ci).filter((ci) => ci !== xIndex && numeric[ci])
  const xName = result.columns[xIndex]?.name ?? ''
  const temporal = /date|time|_at$|^created|^updated|month|day|year|quarter|week/i.test(xName)
  return { xIndex, yIndices, type: temporal ? 'line' : 'bar' }
}

export function canChart(result: QueryResult | null): boolean {
  if (!result || !result.rows.length) return false
  return autoDetect(result).yIndices.length > 0
}

/** Instant-viz option built directly from an arbitrary query result. */
export function optionForResult(
  result: QueryResult,
  override?: ChartType
): EChartsCoreOption | null {
  const d = autoDetect(result)
  if (!d.yIndices.length || !result.rows.length) return null
  const type = override ?? d.type
  if (type === 'pie' || type === 'donut') {
    const yi = d.yIndices[0]
    const data = result.rows.map((r) => ({ name: String(r[d.xIndex] ?? ''), value: num(r[yi]) }))
    return pie(data, type === 'donut')
  }
  const cats = result.rows.map((r) => String(r[d.xIndex] ?? ''))
  const t = baseAxisType(type)
  const series = d.yIndices.map((yi) => ({
    name: result.columns[yi].name,
    type: t,
    smooth: type === 'line' || type === 'area',
    areaStyle: type === 'area' ? {} : undefined,
    data: result.rows.map((r) => num(r[yi]))
  }))
  return cartesian(cats, series, type === 'hbar')
}
