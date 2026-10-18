// Map query results into ECharts options. Saved-chart queries return columns
// named `x`, optional `series`, and `y`; instant-viz works off any result via
// auto-detection. Colours are read from the active theme's CSS variables.
import type { EChartsCoreOption } from 'echarts'
import type { ChartType, MetricFormat, QueryResult } from '@shared/types'

const FALLBACK_PALETTE = [
  '#2dd4bf', '#5b8def', '#e0a14a', '#b07fd6', '#22d3ee', '#ec4899', '#a3e635', '#f59e0b'
]

/** Series colours from the active theme (--chart-1 … --chart-8). */
function chartPalette(): string[] {
  return FALLBACK_PALETTE.map((fb, i) => cssVar(`--chart-${i + 1}`, fb))
}

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

/** Apply an alpha to a #rrggbb colour (passes through non-hex untouched). */
function hexA(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
/** A vertical top→bottom gradient between two alpha stops of a base colour. */
function vGradient(color: string, topA: number, botA: number): Record<string, unknown> {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: hexA(color, topA) },
      { offset: 1, color: hexA(color, botA) }
    ]
  }
}

/** Apply the mock's visual styling to one series based on the chart type. */
function decorate(s: Record<string, unknown>, type: ChartType, idx: number): Record<string, unknown> {
  const pal = chartPalette()
  const color = pal[idx % pal.length]
  if (type === 'bar' || type === 'hbar') {
    const r = type === 'hbar' ? [0, 4, 4, 0] : [4, 4, 0, 0]
    s.itemStyle = { borderRadius: r, color: vGradient(color, 1, 0.55) }
    s.barMaxWidth = 40
  } else if (type === 'line' || type === 'area') {
    s.smooth = true
    s.showSymbol = false
    s.lineStyle = { width: 2.5, color }
    s.itemStyle = { color }
    s.emphasis = { focus: 'series' }
    s.areaStyle = type === 'area' ? { color: vGradient(color, 0.32, 0) } : undefined
  }
  return s
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
  const cat = {
    type: 'category' as const,
    data: categories,
    axisLabel: { color: c.dim, fontFamily: 'JetBrains Mono', fontSize: 10 },
    axisTick: { show: false },
    axisLine: { lineStyle: { color: c.border } }
  }
  const val = {
    type: 'value' as const,
    axisLabel: { color: c.dim, fontFamily: 'JetBrains Mono', fontSize: 10 },
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: c.border, type: 'dashed' as const } }
  }
  return {
    color: chartPalette(),
    grid: { left: 8, right: 16, top: series.length > 1 ? 38 : 14, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: cssVar('--bg-elevated', '#1b2438'),
      borderColor: cssVar('--border-strong', '#2e3a55'),
      textStyle: { color: c.text, fontSize: 12 }
    },
    legend: series.length > 1 ? { textStyle: { color: c.dim }, top: 4, icon: 'roundRect', itemHeight: 9 } : undefined,
    xAxis: horizontal ? val : cat,
    yAxis: horizontal ? cat : val,
    series
  }
}

function pie(data: { name: string; value: number }[], donut: boolean): EChartsCoreOption {
  const c = palette()
  return {
    color: chartPalette(),
    tooltip: {
      trigger: 'item',
      formatter: '{b}: {c} ({d}%)',
      backgroundColor: cssVar('--bg-elevated', '#1b2438'),
      borderColor: cssVar('--border-strong', '#2e3a55'),
      textStyle: { color: c.text, fontSize: 12 }
    },
    legend: {
      type: 'scroll',
      orient: 'vertical',
      right: 8,
      top: 'middle',
      icon: 'roundRect',
      itemHeight: 9,
      textStyle: { color: c.dim, fontSize: 12 }
    },
    series: [
      {
        type: 'pie',
        radius: donut ? ['52%', '74%'] : ['0%', '72%'],
        center: ['38%', '52%'],
        avoidLabelOverlap: true,
        label: { show: false },
        itemStyle: {
          borderColor: cssVar('--bg-panel', '#0e1626'),
          borderWidth: 2,
          borderRadius: 4
        },
        emphasis: { scale: true, scaleSize: 6 },
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
    series = names.map((n, i) =>
      decorate({ name: n, type: t, data: cats.map((cat) => grid.get(n)?.get(cat) ?? 0) }, type, i)
    )
  } else {
    const m = new Map(result.rows.map((r) => [String(r[xi] ?? ''), num(r[yi])]))
    series = [decorate({ type: t, data: cats.map((cat) => m.get(cat) ?? 0) }, type, 0)]
  }
  return cartesian(cats, series, type === 'hbar')
}

// ---- pivot ------------------------------------------------------------------

export interface PivotModel {
  rowKeys: string[]
  colKeys: string[]
  /** Cell value for a (rowKey, colKey) pair; 0 when absent. */
  value: (r: string, c: string) => number
  rowTotal: (r: string) => number
  colTotal: (c: string) => number
  grand: number
  /** True when the source had no series column (single "Total" column). */
  singleCol: boolean
}

/**
 * Cross-tabulate an x/[series]/y result into a rows × columns matrix of the
 * measure, with row, column and grand totals. Rows come from `x`, columns from
 * `series` (or a single "Total" column when there's no series).
 */
export function pivotModel(result: QueryResult): PivotModel | null {
  const xi = idx(result, 'x')
  const si = idx(result, 'series')
  const yi = idx(result, 'y')
  if (xi < 0 || yi < 0 || !result.rows.length) return null

  const singleCol = si < 0
  const rowKeys: string[] = []
  const colKeys: string[] = []
  const seenR = new Set<string>()
  const seenC = new Set<string>()
  const cells = new Map<string, number>()
  const rowTot = new Map<string, number>()
  const colTot = new Map<string, number>()
  let grand = 0

  for (const row of result.rows) {
    const r = String(row[xi] ?? '')
    const c = singleCol ? 'Total' : String(row[si] ?? '')
    const v = num(row[yi])
    if (!seenR.has(r)) { seenR.add(r); rowKeys.push(r) }
    if (!seenC.has(c)) { seenC.add(c); colKeys.push(c) }
    const key = `${r} ${c}`
    cells.set(key, (cells.get(key) ?? 0) + v)
    rowTot.set(r, (rowTot.get(r) ?? 0) + v)
    colTot.set(c, (colTot.get(c) ?? 0) + v)
    grand += v
  }
  return {
    rowKeys,
    colKeys,
    value: (r, c) => cells.get(`${r} ${c}`) ?? 0,
    rowTotal: (r) => rowTot.get(r) ?? 0,
    colTotal: (c) => colTot.get(c) ?? 0,
    grand,
    singleCol
  }
}

/** Flatten a pivot into header + data rows (for table export / PDF). */
export function pivotToTable(p: PivotModel): { columns: string[]; rows: unknown[][] } {
  const columns = ['', ...p.colKeys, 'Total']
  const rows: unknown[][] = p.rowKeys.map((r) => [
    r,
    ...p.colKeys.map((c) => p.value(r, c)),
    p.rowTotal(r)
  ])
  rows.push(['Total', ...p.colKeys.map((c) => p.colTotal(c)), p.grand])
  return { columns, rows }
}

/** Format a numeric value for a KPI/metric card according to its MetricFormat. */
export function formatMetric(value: number | null, format?: MetricFormat): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const style = format?.style ?? 'plain'
  const decimals = format?.decimals ?? (style === 'percent' ? 1 : 0)
  if (style === 'currency') {
    const body = value.toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: decimals,
      minimumFractionDigits: decimals
    })
    return `${format?.prefix ?? ''}${body}${format?.suffix ?? ''}`
  }
  const n = (style === 'percent' ? value * 100 : value).toLocaleString(undefined, {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0
  })
  const suffix = (format?.suffix ?? '') + (style === 'percent' ? '%' : '')
  return `${format?.prefix ?? ''}${n}${suffix}`
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
  const series = d.yIndices.map((yi, i) =>
    decorate(
      { name: result.columns[yi].name, type: t, data: result.rows.map((r) => num(r[yi])) },
      type,
      i
    )
  )
  return cartesian(cats, series, type === 'hbar')
}
