import type { ActivityKind, ActivitySeverity, ActivityStatus } from '../../../shared/types/activity'

export type { ActivityKind, ActivitySeverity, ActivityStatus }

// What a caller hands to recordEvent/withSpan (the recorder fills id/trace/parent/timestamps).
export interface SpanInput {
  kind: ActivityKind
  name: string
  status?: ActivityStatus      // default 'ok'
  severity?: ActivitySeverity  // default 'info'
  usage?: string | null
  provider?: string | null
  modelId?: string | null
  attempt?: number | null
  durationMs?: number | null
  tokens?: Record<string, number> | null
  request?: unknown
  response?: unknown
  error?: { message: string, stack?: string, cause?: string } | null
  meta?: Record<string, unknown>
}

export interface ObservabilityConfig {
  version: 1
  retainInfoDays: number
  retainErrorDays: number
  maxRows: number
  capture: Record<ActivityKind, boolean>
  alerts: {
    badge: boolean
    toast: boolean
    email: {
      enabled: boolean
      recipient: string | null
      from: string | null
      apiKeyEnc: string | null // Resend key, AES-GCM via ai/registry/crypto.ts; server-only
      minSeverity: 'warn' | 'error'
      digestWindowMin: number
    }
  }
}

export const DEFAULT_CONFIG: ObservabilityConfig = {
  version: 1,
  retainInfoDays: 14,
  retainErrorDays: 90,
  maxRows: 500_000,
  capture: { inbound: true, job: true, model: true, attempt: true, tool: true },
  alerts: {
    badge: true,
    toast: true,
    email: {
      enabled: false,
      recipient: null,
      from: null,
      apiKeyEnc: null,
      minSeverity: 'error',
      digestWindowMin: 15
    }
  }
}
