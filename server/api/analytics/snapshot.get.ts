import { loadAnalyticsConfig } from '../../lib/analytics/store'
import { promInstant } from '../../lib/analytics/prom'
import { SNAPSHOT_QUERIES, type SnapshotQueryId } from '../../lib/analytics/queries'
import { buildSnapshot } from '../../lib/analytics/snapshot'
import type { PromVectorResult } from '../../lib/analytics/prom'

export default defineEventHandler(async () => {
  const cfg = await loadAnalyticsConfig()
  const ids = Object.keys(SNAPSHOT_QUERIES) as SnapshotQueryId[]
  let entries: [SnapshotQueryId, PromVectorResult[]][]
  try {
    entries = await Promise.all(ids.map(async id =>
      [id, await promInstant(cfg.prometheusUrl, SNAPSHOT_QUERIES[id])] as [SnapshotQueryId, PromVectorResult[]]
    ))
  } catch (err) {
    throw createError({ statusCode: 502, statusMessage: `Prometheus unreachable: ${(err as Error).message}` })
  }
  return buildSnapshot(Object.fromEntries(entries), cfg.gpuLabels)
})
