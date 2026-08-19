import { loadAnalyticsConfig } from '../../lib/analytics/store'
import { promInstant } from '../../lib/analytics/prom'
import { SNAPSHOT_QUERIES, PUBLIC_RIG_SNAPSHOT_IDS, PUBLIC_RIG_EXTRA_QUERIES } from '../../lib/analytics/queries'
import type { SnapshotQueryId } from '../../lib/analytics/queries'
import { buildSnapshot } from '../../lib/analytics/snapshot'
import { buildPublicRig } from '../../lib/analytics/public-rig'
import type { PublicRigExtras } from '../../lib/analytics/public-rig'
import { getSessionTokensSince } from '../../services/usage'
import type { PromVectorResult } from '../../lib/analytics/prom'
import type { PublicRigResponse } from '../../../shared/types/analytics'

/**
 * GET /api/public/rig — PUBLIC (see PUBLIC_PREFIXES in middleware/auth.ts), read-only,
 * curated homelab status for techhivelabs.net's "Live from the rig" strip.
 *
 * Same Prometheus catalog as /api/analytics/snapshot, minus spend and power, plus the 24h
 * token picture (Claude Code sessions from Postgres + vLLM/llama.cpp engine counters, with the
 * LiteLLM gateway figure as a breakdown line) and the 24h model roster. Assembled by the pure `buildPublicRig` — the allow-list lives there.
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
  const q = (expr: string) => promInstant(cfg.prometheusUrl, expr)
  const X = PUBLIC_RIG_EXTRA_QUERIES
  let entries: [SnapshotQueryId, PromVectorResult[]][]
  let extras: PublicRigExtras
  try {
    const [snap, tokens24h, modelTokens, modelRequests, vllmPrompt, vllmGen, llamaPrompt, llamaGen] = await Promise.all([
      Promise.all(PUBLIC_RIG_SNAPSHOT_IDS.map(async id =>
        [id, await q(SNAPSHOT_QUERIES[id])] as [SnapshotQueryId, PromVectorResult[]]
      )),
      q(X.tokens24h), q(X.modelTokens24h), q(X.modelRequests24h),
      q(X.vllmPrompt24h), q(X.vllmGen24h), q(X.llamaPrompt24h), q(X.llamaGen24h),
    ])
    entries = snap
    extras = { tokens24h, modelTokens, modelRequests, vllmPrompt, vllmGen, llamaPrompt, llamaGen }
  } catch {
    // Deliberately generic: the private snapshot route echoes the upstream error, but this
    // route is public and the message would carry the internal Prometheus URL.
    throw createError({ statusCode: 502, statusMessage: 'Prometheus unreachable' })
  }

  // Claude Code tokens come from Postgres, not Prometheus. A DB hiccup must not take the
  // whole strip down with it: the breakdown line just reads null.
  try {
    extras.claudeCodeTokens = await getSessionTokensSince(new Date(Date.now() - 24 * 60 * 60 * 1000))
  } catch {
    extras.claudeCodeTokens = null
  }

  const body = buildPublicRig(buildSnapshot(Object.fromEntries(entries), cfg.gpuLabels), extras)
  cache = { at: Date.now(), body }
  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, s-maxage=30')
  return body
})
