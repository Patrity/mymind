// Shared client/server types for the activity log.
export const ACTIVITY_KINDS = ['inbound', 'job', 'model', 'attempt', 'tool'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export type ActivitySeverity = 'debug' | 'info' | 'warn' | 'error'
export type ActivityStatus = 'ok' | 'error' | 'warn'

export interface ActivityDTO {
  id: string
  traceId: string
  parentId: string | null
  kind: ActivityKind
  name: string
  status: ActivityStatus
  severity: ActivitySeverity
  usage: string | null
  provider: string | null
  modelId: string | null
  attempt: number | null
  durationMs: number | null
  tokens: { prompt?: number, completion?: number, total?: number } | null
  request: unknown
  response: unknown
  error: { message: string, stack?: string, cause?: string } | null
  meta: Record<string, unknown>
  ackedAt: string | null
  createdAt: string
  finishedAt: string | null
}

export interface ActivityListParams {
  kind?: ActivityKind
  status?: ActivityStatus
  severity?: ActivitySeverity
  usage?: string
  traceId?: string
  q?: string
  limit?: number
  before?: string // ISO cursor (createdAt) for pagination
}

export interface ActivityCount {
  unacked: number
  latest: { id: string, name: string, severity: ActivitySeverity, at: string } | null
}
