// Shared client/server DTOs for the /analytics slice. No logic here.
// `AnalyticsConfig` (server-only, holds the encrypted LiteLLM key) stays in
// server/lib/analytics/types.ts — it never crosses the API boundary.

export const RANGE_KEYS = ['1h', '6h', '24h', '7d'] as const
export type RangeKey = typeof RANGE_KEYS[number]

export interface SeriesPoint { t: number, v: number | null } // t = epoch ms
export interface Series { name: string, points: SeriesPoint[] }
export interface SeriesResponse { panel: string, range: RangeKey, series: Series[] }

export interface GpuSnapshot {
  uuid: string
  label: string
  utilPct: number | null
  vramUsedBytes: number | null
  vramTotalBytes: number | null
  tempC: number | null
  powerW: number | null
  powerLimitW: number | null
}

export interface ServiceHealth { id: string, label: string, up: boolean | null } // null = no data
export interface EngineSnapshot { model: string, running: number, waiting: number }

export interface SnapshotResponse {
  gpus: GpuSnapshot[]
  services: ServiceHealth[]
  engines: EngineSnapshot[]
  spendByModel: { model: string, usd: number }[]
}

export interface RequestLogRow {
  id: string
  startedAt: string // ISO
  model: string
  promptTokens: number | null
  completionTokens: number | null
  latencyMs: number | null
  spendUsd: number | null
  keyAlias: string | null
  cacheHit: boolean | null
  status: 'success' | 'failure' | null
}

export interface RequestLogResponse {
  rows: RequestLogRow[]
  page: number
  pageSize: number
  totalPages: number | null // null when upstream doesn't report it
}

/**
 * The PUBLIC, unauthenticated rig-status payload served by `GET /api/public/rig` and consumed by
 * techhivelabs.net's "Live from the rig" strip. A deliberate, curated subset of `SnapshotResponse`:
 * no GPU uuids, no power draw, no spend (money), no LiteLLM/Prometheus plumbing services. Anything
 * added here is visible to the whole internet — keep it to what a homepage badge needs.
 */
export interface PublicRigGpu {
  label: string
  utilPct: number | null
  vramUsedBytes: number | null
  vramTotalBytes: number | null
  tempC: number | null
}

export interface PublicRigResponse {
  /** ISO timestamp of when this payload was assembled (server-side cache may serve it for ~30s). */
  generatedAt: string
  gpus: PublicRigGpu[]
  /** vLLM engines by model name (running / waiting request counts). */
  engines: EngineSnapshot[]
  /** Curated user-facing services only (see PUBLIC_RIG_SERVICE_IDS). */
  services: ServiceHealth[]
  /**
   * All tokens the setup pushed in the trailing 24h: Claude Code sessions (MyMind's `messages`)
   * + local inference counted at the engines (vLLM + llama.cpp). LiteLLM-gateway tokens are NOT
   * summed (they overlap vLLM and under-count it); they appear in the breakdown only.
   * null only when every source is absent.
   */
  tokens24h: number | null
  tokensBreakdown24h: PublicRigTokenBreakdown
  /** Models LiteLLM routed to in the trailing 24h, most tokens first (capped). */
  models24h: PublicRigModel[]
}

export interface PublicRigTokenBreakdown {
  /** Claude Code session tokens (input + output + cache read + cache creation) from Postgres. */
  claudeCode: number | null
  /** vLLM prompt + generation tokens at the engine (Prometheus). */
  vllm: number | null
  /** llama.cpp prompt + predicted tokens at the engine (Prometheus). */
  llamacpp: number | null
  /** LiteLLM gateway tokens — informational, overlaps vllm/llamacpp, never added to the total. */
  litellm: number | null
}

/** `model` is LiteLLM's label as-is (often provider-prefixed, e.g. `openai/qwen3.6-35b-a3b`). */
export interface PublicRigModel { model: string, tokens: number, requests: number }
