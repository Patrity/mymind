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

// LiteLLM's exporter emits an `unknown` model bucket (unattributed calls) that dwarfs the real
// series and means nothing to a reader. Never publish it, or any unlabelled sample.
const UNPUBLISHABLE_MODELS = new Set(['unknown', '?', ''])

export function buildPublicRig(
  snapshot: SnapshotResponse,
  tokens24hVec: PromVectorResult[] | undefined,
  nowMs = Date.now(),
  modelTokensVec: PromVectorResult[] | undefined = undefined,
  modelRequestsVec: PromVectorResult[] | undefined = undefined
): PublicRigResponse {
  const roster = new Map<string, { tokens: number, requests: number }>()
  const bump = (vec: PromVectorResult[] | undefined, key: 'tokens' | 'requests') => {
    for (const r of vec ?? []) {
      const model = r.metric.model ?? '?'
      if (UNPUBLISHABLE_MODELS.has(model)) continue
      const n = Math.round(num(r) ?? 0)
      if (n <= 0) continue
      const row = roster.get(model) ?? { tokens: 0, requests: 0 }
      row[key] += n
      roster.set(model, row)
    }
  }
  bump(modelTokensVec, 'tokens')
  bump(modelRequestsVec, 'requests')
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
    models24h: [...roster.entries()]
      .map(([model, v]) => ({ model, tokens: v.tokens, requests: v.requests }))
      .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests)
      .slice(0, PUBLIC_RIG_MODEL_CAP)
  }
}
