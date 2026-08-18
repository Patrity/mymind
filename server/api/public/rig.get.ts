import { loadAnalyticsConfig } from '../../lib/analytics/store'
import { promInstant } from '../../lib/analytics/prom'
import { SNAPSHOT_QUERIES, PUBLIC_RIG_SNAPSHOT_IDS, PUBLIC_RIG_EXTRA_QUERIES } from '../../lib/analytics/queries'
import type { SnapshotQueryId } from '../../lib/analytics/queries'
import { buildSnapshot } from '../../lib/analytics/snapshot'
import { buildPublicRig } from '../../lib/analytics/public-rig'
import type { PromVectorResult } from '../../lib/analytics/prom'
import type { PublicRigResponse } from '../../../shared/types/analytics'

/**
 * GET /api/public/rig — PUBLIC (see PUBLIC_PREFIXES in middleware/auth.ts), read-only,
 * curated homelab status for techhivelabs.net's "Live from the rig" strip.
 *
 * Same Prometheus catalog as /api/analytics/snapshot, minus spend and power, plus a 24h
 * LiteLLM token total. Assembled by the pure `buildPublicRig` — the allow-list lives there.
 *
 * Because it is unauthenticated it is cached in-process for CACHE_MS so a burst of
 * anonymous traffic costs Prometheus at most one fan-out per window, and it sends
 * `Cache-Control` so CDNs/browsers hold it too. CORS is `*`: the payload is public by
 * definition and the consumer is a static site on another origin.
 *
 * Prometheus unreachable -> 502 (the analytics convention). "Rig powered off" is NOT an
 * error: Prometheus still answers, the nvidia exporter is simply down, and `gpus` comes
 * back empty — the consumer renders that as "asleep".
 */
const CACHE_MS = 30_000
let cache: { at: number, body: PublicRigResponse } | null = null

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  // Errors are cached briefly too — a public route must not turn a Prometheus outage into a
  // retry storm against the homelab. Success is refreshed a bit slower.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=15, s-maxage=15')

  if (cache && Date.now() - cache.at < CACHE_MS) {
    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, s-maxage=30')
    return cache.body
  }

  const cfg = await loadAnalyticsConfig()
  let entries: [SnapshotQueryId, PromVectorResult[]][]
  let tokens24h: PromVectorResult[]
  try {
    ;[entries, tokens24h] = await Promise.all([
      Promise.all(PUBLIC_RIG_SNAPSHOT_IDS.map(async id =>
        [id, await promInstant(cfg.prometheusUrl, SNAPSHOT_QUERIES[id])] as [SnapshotQueryId, PromVectorResult[]]
      )),
      promInstant(cfg.prometheusUrl, PUBLIC_RIG_EXTRA_QUERIES.tokens24h),
    ])
  } catch {
    // Deliberately generic: the private snapshot route echoes the upstream error, but this
    // route is public and the message would carry the internal Prometheus URL.
    throw createError({ statusCode: 502, statusMessage: 'Prometheus unreachable' })
  }

  const body = buildPublicRig(buildSnapshot(Object.fromEntries(entries), cfg.gpuLabels), tokens24h)
  cache = { at: Date.now(), body }
  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, s-maxage=30')
  return body
})
