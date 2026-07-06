import { loadAnalyticsConfig } from '../../lib/analytics/store'
import { promRange, toSeries, windowForRange } from '../../lib/analytics/prom'
import { RANGE_PANELS } from '../../lib/analytics/queries'
import { RANGE_KEYS, type RangeKey, type SeriesResponse } from '../../../shared/types/analytics'

export default defineEventHandler(async (event): Promise<SeriesResponse> => {
  const q = getQuery(event)
  const panelId = String(q.panel ?? '')
  const range = String(q.range ?? '') as RangeKey
  const panel = Object.hasOwn(RANGE_PANELS, panelId) ? RANGE_PANELS[panelId] : undefined
  if (!panel) throw createError({ statusCode: 400, statusMessage: `unknown panel: ${panelId}` })
  if (!RANGE_KEYS.includes(range)) throw createError({ statusCode: 400, statusMessage: `unknown range: ${range}` })

  const cfg = await loadAnalyticsConfig()
  const w = windowForRange(range)
  try {
    const perQuery = await Promise.all(panel.queries.map(async (def) => {
      const matrix = await promRange(cfg.prometheusUrl, def.expr(w), range)
      return toSeries(matrix, labels => def.legend(labels, cfg.gpuLabels))
    }))
    return { panel: panelId, range, series: perQuery.flat() }
  } catch (err) {
    throw createError({ statusCode: 502, statusMessage: `Prometheus unreachable: ${(err as Error).message}` })
  }
})
