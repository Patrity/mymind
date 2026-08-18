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

export function buildPublicRig(
  snapshot: SnapshotResponse,
  tokens24hVec: PromVectorResult[] | undefined,
  nowMs = Date.now()
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
    tokens24h: tokens24hVec?.length ? num(tokens24hVec[0]) : null
  }
}
