// Shared client/server DTOs for the home dashboard. No logic here.

/**
 * Ranges for the home dashboard. DELIBERATELY separate from `RangeKey` in
 * ./analytics.ts (`1h|6h|24h|7d`, Prometheus) and `UsageRangeKey` in ./usage.ts
 * (`7d|30d|90d|all`, Postgres daily buckets). All three spell `7d`; none of them
 * mean the same query. A shared ref would typecheck and silently query wrong.
 */
export const HOME_RANGE_KEYS = ['1d', '3d', '7d', '30d'] as const
export type HomeRangeKey = typeof HOME_RANGE_KEYS[number]

export const HOME_RANGE_DEFAULT: HomeRangeKey = '3d'

export type TimelineType =
  | 'session' | 'memory' | 'document' | 'image'
  | 'clipboard' | 'task' | 'conflict' | 'error'

export interface TimelineEntry {
  id: string
  type: TimelineType
  /** ISO timestamp. */
  at: string
  title: string
  subtitle?: string
  projectSlug?: string
  /** Always populated — every row renders as a real link. */
  href: string
  /** Present iff this row is a collapsed group of `count` events. */
  count?: number
}

export interface TimelineDay {
  /** 'YYYY-MM-DD', UTC. */
  day: string
  entries: TimelineEntry[]
}

export interface HomeTimeline {
  days: TimelineDay[]
  /** Rows actually returned. */
  shown: number
  /** Rows that would exist uncapped (post-grouping). `shown < total` ⇒ disclose it. */
  total: number
}

export interface HomeCount { total: number, delta: number }

export interface HomeMetrics {
  sessions: HomeCount
  memories: HomeCount
  documents: HomeCount
  images: HomeCount
}

/** Absolute backlog. NEVER range-scoped — see the spec. */
export interface HomeAttention {
  conflicts: number
  unreviewedMemories: number
  unackedErrors: number
  unfiledCaptures: number
}

export interface HomeUsage {
  tokens: number
  cacheReadPct: number
  /** API-equivalent value, not money. Label: "at API rates — not billed". */
  valueUsd: number
  /** Non-empty ⇒ some models had no price row (cold start); never render 0 for these. */
  unpricedModels: string[]
}

export interface HomeTaskRow {
  id: string
  title: string
  status: string
  dueDate: string | null
  overdue: boolean
  projectSlug: string | null
  href: string
}

export interface HomeProjectRow {
  slug: string
  name: string
  color: string | null
  sessions: number
  memories: number
  lastActivityAt: string
  href: string
}

export interface HomeResponse {
  range: HomeRangeKey
  generatedAt: string
  metrics: HomeMetrics
  usage: HomeUsage
  timeline: HomeTimeline
  attention: HomeAttention
  tasks: HomeTaskRow[]
  projects: HomeProjectRow[]
}
