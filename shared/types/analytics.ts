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
