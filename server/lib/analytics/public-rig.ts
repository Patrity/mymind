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

export interface PublicRigExtras {
  /** LiteLLM gateway total (scalar vector). */
  tokens24h?: PromVectorResult[]
  modelTokens?: PromVectorResult[]
  modelRequests?: PromVectorResult[]
  vllmPrompt?: PromVectorResult[]
  vllmGen?: PromVectorResult[]
  llamaPrompt?: PromVectorResult[]
  llamaGen?: PromVectorResult[]
  /** Claude Code session tokens over the window, from Postgres (null when the DB read failed). */
  claudeCodeTokens?: number | null
}

const scalar = (vec: PromVectorResult[] | undefined): number | null =>
  vec?.length ? num(vec[0]) : null

/** Sum of nullable parts; null only when every part is null. */
const sumNullable = (...parts: (number | null | undefined)[]): number | null => {
  const present = parts.filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
  return present.length ? present.reduce((a, b) => a + b, 0) : null
}

export function buildPublicRig(
  snapshot: SnapshotResponse,
  extras: PublicRigExtras = {},
  nowMs = Date.now()
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
  bump(extras.modelTokens, 'tokens')
  bump(extras.modelRequests, 'requests')

  const round = (n: number | null) => (n == null ? null : Math.round(n))
  const breakdown = {
    claudeCode: round(extras.claudeCodeTokens ?? null),
    vllm: round(sumNullable(scalar(extras.vllmPrompt), scalar(extras.vllmGen))),
    llamacpp: round(sumNullable(scalar(extras.llamaPrompt), scalar(extras.llamaGen))),
    litellm: round(scalar(extras.tokens24h))
  }

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
    // The total deliberately excludes the LiteLLM gateway figure: it overlaps the engine counters
    // (routed vLLM/llama.cpp traffic) and under-counts them (direct callers bypass the gateway).
    tokens24h: sumNullable(breakdown.claudeCode, breakdown.vllm, breakdown.llamacpp),
    tokensBreakdown24h: breakdown,
    models24h: [...roster.entries()]
      .map(([model, v]) => ({ model, tokens: v.tokens, requests: v.requests }))
      .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests)
      .slice(0, PUBLIC_RIG_MODEL_CAP)
  }
}
