import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AnalyticsChart,
  AnalyticsDashboard,
  AnalyticsDashboardWidget,
  AnalyticsDataset,
  AnalyticsOpWidget,
  AnalyticsPlan,
  AnalyticsState
} from '@shared/types'
import { useWorkspace } from './workspace'

export const useAnalytics = defineStore('analytics', () => {
  const datasets = ref<AnalyticsDataset[]>([])
  const charts = ref<AnalyticsChart[]>([])
  const dashboards = ref<AnalyticsDashboard[]>([])
  const loadedConns = ref<Set<string>>(new Set())

  async function loadFor(connId: string, force = false): Promise<void> {
    if (!force && loadedConns.value.has(connId)) return
    const [ds, cs, db] = await Promise.all([
      window.api.analytics.listDatasets(connId),
      window.api.analytics.listCharts(connId),
      window.api.analytics.listDashboards(connId)
    ])
    // Replace this connection's entries, keep others.
    datasets.value = [...datasets.value.filter((d) => d.connectionId !== connId), ...ds]
    charts.value = [...charts.value.filter((c) => c.connectionId !== connId), ...cs]
    dashboards.value = [...dashboards.value.filter((d) => d.connectionId !== connId), ...db]
    loadedConns.value = new Set(loadedConns.value).add(connId)
  }

  const datasetsFor = (connId: string): AnalyticsDataset[] =>
    datasets.value
      .filter((d) => d.connectionId === connId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const chartsFor = (connId: string): AnalyticsChart[] =>
    charts.value
      .filter((c) => c.connectionId === connId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const getDataset = (id: string): AnalyticsDataset | undefined =>
    datasets.value.find((d) => d.id === id)
  const dashboardsFor = (connId: string): AnalyticsDashboard[] =>
    dashboards.value
      .filter((d) => d.connectionId === connId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const getChart = (id: string): AnalyticsChart | undefined =>
    charts.value.find((c) => c.id === id)
  const getDashboard = (id: string): AnalyticsDashboard | undefined =>
    dashboards.value.find((d) => d.id === id)

  async function saveDataset(
    input: Partial<AnalyticsDataset> & Pick<AnalyticsDataset, 'connectionId' | 'name' | 'source'>
  ): Promise<AnalyticsDataset> {
    const saved = await window.api.analytics.saveDataset(input)
    datasets.value = [...datasets.value.filter((d) => d.id !== saved.id), saved]
    return saved
  }
  async function removeDataset(id: string): Promise<void> {
    await window.api.analytics.removeDataset(id)
    datasets.value = datasets.value.filter((d) => d.id !== id)
    // Cascade (mirrors main): drop charts on this dataset, then widgets on those charts.
    const droppedCharts = new Set(charts.value.filter((c) => c.datasetId === id).map((c) => c.id))
    charts.value = charts.value.filter((c) => c.datasetId !== id)
    dashboards.value = dashboards.value.map((d) =>
      d.widgets.some((w) => droppedCharts.has(w.chartId))
        ? { ...d, widgets: d.widgets.filter((w) => !droppedCharts.has(w.chartId)) }
        : d
    )
  }
  async function saveChart(
    input: Partial<AnalyticsChart> &
      Pick<AnalyticsChart, 'connectionId' | 'datasetId' | 'name' | 'type' | 'encoding'>
  ): Promise<AnalyticsChart> {
    const saved = await window.api.analytics.saveChart(input)
    charts.value = [...charts.value.filter((c) => c.id !== saved.id), saved]
    return saved
  }
  async function removeChart(id: string): Promise<void> {
    await window.api.analytics.removeChart(id)
    charts.value = charts.value.filter((c) => c.id !== id)
    // Mirror the main process's cascade: drop widgets referencing this chart.
    dashboards.value = dashboards.value.map((d) =>
      d.widgets.some((w) => w.chartId === id)
        ? { ...d, widgets: d.widgets.filter((w) => w.chartId !== id) }
        : d
    )
  }

  async function saveDashboard(
    input: Partial<AnalyticsDashboard> &
      Pick<AnalyticsDashboard, 'connectionId' | 'name' | 'widgets'>
  ): Promise<AnalyticsDashboard> {
    const saved = await window.api.analytics.saveDashboard(input)
    dashboards.value = [...dashboards.value.filter((d) => d.id !== saved.id), saved]
    return saved
  }
  async function removeDashboard(id: string): Promise<void> {
    await window.api.analytics.removeDashboard(id)
    dashboards.value = dashboards.value.filter((d) => d.id !== id)
  }

  /**
   * A snapshot of this connection's analytics objects, for the AI to edit in place.
   */
  function stateFor(connId: string): AnalyticsState {
    return {
      datasets: datasetsFor(connId).map((d) => ({ id: d.id, name: d.name, source: d.source })),
      charts: chartsFor(connId).map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        icon: c.icon,
        datasetId: c.datasetId,
        encoding: c.encoding
      })),
      dashboards: dashboardsFor(connId).map((d) => ({
        id: d.id,
        name: d.name,
        widgets: d.widgets
      }))
    }
  }

  function resolveWidgets(
    widgets: AnalyticsOpWidget[],
    chartKeyToId: Map<string, string>
  ): AnalyticsDashboardWidget[] {
    let cursorY = 0
    return widgets
      .map((w) => {
        const chartId = w.chartId ?? (w.chartKey ? chartKeyToId.get(w.chartKey) : undefined)
        if (!chartId) return null
        const wd = w.w && w.w > 0 ? w.w : 6
        const ht = w.h && w.h > 0 ? w.h : 8
        const x = typeof w.x === 'number' ? w.x : 0
        const y = typeof w.y === 'number' ? w.y : cursorY
        cursorY = Math.max(cursorY, y + ht)
        return { chartId, x, y, w: wd, h: ht }
      })
      .filter((w): w is AnalyticsDashboardWidget => w !== null)
  }

  /**
   * Execute an AI plan's operations in order. New objects are keyed locally so
   * later ops can reference them; existing objects are updated/deleted by id.
   * Returns a summary plus a dashboard to focus (last created/updated one).
   */
  async function applyOps(
    connId: string,
    plan: AnalyticsPlan
  ): Promise<{ created: number; updated: number; deleted: number; focusDashboardId?: string }> {
    const dsKeyToId = new Map<string, string>()
    const chartKeyToId = new Map<string, string>()
    let created = 0
    let updated = 0
    let deleted = 0
    let focusDashboardId: string | undefined

    for (const op of plan.ops) {
      switch (op.op) {
        case 'createDataset': {
          const saved = await saveDataset({ connectionId: connId, name: op.name, source: op.source })
          dsKeyToId.set(op.key, saved.id)
          created++
          break
        }
        case 'updateDataset': {
          const cur = getDataset(op.id)
          if (!cur) break
          await saveDataset({
            id: cur.id,
            connectionId: connId,
            name: op.name ?? cur.name,
            source: op.source ?? cur.source
          })
          updated++
          break
        }
        case 'deleteDataset':
          await removeDataset(op.id)
          deleted++
          break
        case 'createChart': {
          const datasetId = op.datasetId ?? (op.datasetKey ? dsKeyToId.get(op.datasetKey) : undefined)
          if (!datasetId) break
          const saved = await saveChart({
            connectionId: connId,
            datasetId,
            name: op.name,
            type: op.type,
            encoding: op.encoding,
            icon: op.icon
          })
          if (op.key) chartKeyToId.set(op.key, saved.id)
          created++
          break
        }
        case 'updateChart': {
          const cur = getChart(op.id)
          if (!cur) break
          const datasetId =
            op.datasetId ?? (op.datasetKey ? dsKeyToId.get(op.datasetKey) : undefined) ?? cur.datasetId
          await saveChart({
            id: cur.id,
            connectionId: connId,
            datasetId,
            name: op.name ?? cur.name,
            type: op.type ?? cur.type,
            encoding: op.encoding ?? cur.encoding,
            icon: op.icon !== undefined ? op.icon : cur.icon
          })
          updated++
          break
        }
        case 'deleteChart':
          await removeChart(op.id)
          deleted++
          break
        case 'createDashboard': {
          const saved = await saveDashboard({
            connectionId: connId,
            name: op.name,
            widgets: resolveWidgets(op.widgets, chartKeyToId)
          })
          focusDashboardId = saved.id
          created++
          break
        }
        case 'updateDashboard': {
          const cur = getDashboard(op.id)
          if (!cur) break
          const saved = await saveDashboard({
            id: cur.id,
            connectionId: connId,
            name: op.name ?? cur.name,
            widgets: op.widgets ? resolveWidgets(op.widgets, chartKeyToId) : cur.widgets
          })
          focusDashboardId = saved.id
          updated++
          break
        }
        case 'deleteDashboard':
          await removeDashboard(op.id)
          deleted++
          break
      }
    }
    return { created, updated, deleted, focusDashboardId }
  }

  /**
   * Ask the AI to build or modify analytics from a prompt: generates an op plan
   * (with the current state as context) and applies it. Returns a human summary
   * and a dashboard to focus, if any.
   */
  async function runAi(
    connId: string,
    driver: string,
    prompt: string
  ): Promise<{ notes?: string; summary: string; focusDashboardId?: string }> {
    const ws = useWorkspace()
    const plan = await window.api.ai.generateAnalytics({
      driver,
      // Deep-clone: reactive Proxies can't be structured-cloned across IPC.
      schema: JSON.parse(JSON.stringify(ws.schemas[connId] ?? {})),
      prompt,
      state: JSON.parse(JSON.stringify(stateFor(connId)))
    })
    const r = await applyOps(connId, plan)
    const parts = [
      r.created ? `${r.created} created` : '',
      r.updated ? `${r.updated} updated` : '',
      r.deleted ? `${r.deleted} deleted` : ''
    ].filter(Boolean)
    return {
      notes: plan.notes,
      summary: parts.length ? parts.join(', ') + '.' : 'No changes.',
      focusDashboardId: r.focusDashboardId
    }
  }

  return {
    datasets,
    charts,
    dashboards,
    loadFor,
    datasetsFor,
    chartsFor,
    dashboardsFor,
    getDataset,
    getChart,
    getDashboard,
    saveDataset,
    removeDataset,
    saveChart,
    removeChart,
    saveDashboard,
    removeDashboard,
    stateFor,
    applyOps,
    runAi
  }
})
