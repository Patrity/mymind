import { loadAnalyticsConfig } from '../../lib/analytics/store'
import { promInstant } from '../../lib/analytics/prom'
import { buildSnapshotQueries, type SnapshotQueryId } from '../../lib/analytics/queries'
import { buildSnapshot } from '../../lib/analytics/snapshot'
import type { PromVectorResult } from '../../lib/analytics/prom'

export default defineEventHandler(async () => {
  const cfg = await loadAnalyticsConfig()
  const queries = buildSnapshotQueries(cfg.services, cfg.rigHost)
  const ids = Object.keys(queries) as SnapshotQueryId[]
  let entries: [SnapshotQueryId, PromVectorResult[]][]
  try {
    entries = await Promise.all(ids.map(async id =>
      [id, await promInstant(cfg.prometheusUrl, queries[id])] as [SnapshotQueryId, PromVectorResult[]]
    ))
  } catch (err) {
    throw createError({ statusCode: 502, statusMessage: `Prometheus unreachable: ${(err as Error).message}` })
  }
  return buildSnapshot(Object.fromEntries(entries), cfg.gpuLabels, cfg.services, cfg.rigHost)
})
