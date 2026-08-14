// Shared client/server DTOs for the /analytics Usage tab. No logic here.

/**
 * Day-granularity ranges for the Usage tab. DELIBERATELY separate from `RangeKey`
 * in ./analytics.ts (`1h|6h|24h|7d`, Prometheus step derivation): both spell `7d`
 * but mean different things, and one shared ref would typecheck while producing
 * wrong queries on tab switch.
 */
export const USAGE_RANGE_KEYS = ['7d', '30d', '90d', 'all'] as const
export type UsageRangeKey = typeof USAGE_RANGE_KEYS[number]

export interface UsageTokens {
  input: number
  output: number
  cacheRead: number
  /** The reported total for cache creation; may exceed ephemeral5m + ephemeral1h. */
  cacheCreation: number
  ephemeral5m: number
  ephemeral1h: number
}

export interface ModelRates {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  cacheCreationAbove1h: number
}

export interface ModelUsageRow {
  model: string
  tokens: UsageTokens
  /** null when the model has no price entry — rendered in the unpriced bucket, never as 0. */
  valueUsd: number | null
}

export interface UsageDayPoint { day: string, byModel: Record<string, number> }

export interface UsageResponse {
  range: UsageRangeKey
  totals: {
    tokens: number
    cacheReadPct: number
    valueUsd: number
    sessions: number
    dispatches: number
  }
  byModel: ModelUsageRow[]
  daily: UsageDayPoint[]
  unpriced: { models: string[], tokens: number }
  litellm: { day: string, spendUsd: number, tokens: number }[]
}

export interface DispatchResponse {
  range: UsageRangeKey
  bySubagent: { subagentType: string, count: number }[]
}
