// server/lib/analytics/public-rig.ts
// Pure curation: SnapshotResponse (+ the tokens24h vector) -> PublicRigResponse. No I/O.
// This is the ONLY place that decides what leaves the house unauthenticated — keep it boring
// and keep the allow-list explicit (fields are copied by name, never spread).
import type { PromVectorResult } from './prom'
import { PUBLIC_RIG_SERVICE_IDS } from './queries'
import type { PublicRigResponse, SnapshotResponse } from '../../../shared/types/analytics'

const num = (r: PromVectorResult | undefined): number | null => {
  if (!r) return null
  const n = parseFloat(r.value[1])
  return Number.isFinite(n) ? n : null
}

/** Roster cap: the homepage strip shows a handful and tooltips the rest; nobody needs 40 rows. */
export const PUBLIC_RIG_MODEL_CAP = 12

export function buildPublicRig(
  snapshot: SnapshotResponse,
  tokens24hVec: PromVectorResult[] | undefined,
  nowMs = Date.now(),
  models24hVec: PromVectorResult[] | undefined = undefined
): PublicRigResponse {
  const allowed = new Set<string>(PUBLIC_RIG_SERVICE_IDS)
  return {
    generatedAt: new Date(nowMs).toISOString(),
    gpus: snapshot.gpus.map(g => ({
      label: g.label,
      utilPct: g.utilPct,
      vramUsedBytes: g.vramUsedBytes,
      vramTotalBytes: g.vramTotalBytes,
      tempC: g.tempC
    })),
    engines: snapshot.engines.map(e => ({ model: e.model, running: e.running, waiting: e.waiting })),
    services: snapshot.services
      .filter(s => allowed.has(s.id))
      .map(s => ({ id: s.id, label: s.label, up: s.up })),
    // `sum(increase(...))` returns a single label-less sample, or nothing when the series is absent.
    tokens24h: tokens24hVec?.length ? num(tokens24hVec[0]) : null,
    models24h: (models24hVec ?? [])
      .map(r => ({ model: r.metric.model ?? '?', requests: Math.round(num(r) ?? 0) }))
      .filter(m => m.model !== '?' && m.requests > 0)
      .sort((a, b) => b.requests - a.requests)
      .slice(0, PUBLIC_RIG_MODEL_CAP)
  }
}
