// Cycle 81 (spec §5): the workstream wire shapes, shared by core and the app (Task 6 UI).
export type WorkstreamState = 'queued' | 'running' | 'attention' | 'done' | 'failed' | 'cancelled'

export interface WorkstreamBudget { maxSteps: number; maxWallMs: number }

/** Persisted every step. `wallMs` is ACTIVE time: segments executing, minus time parked on an
 *  approval card — attention, queue waits and worker downtime never count (see loop.ts). */
export interface WorkstreamUsed { steps: number; wallMs: number; inputTokens: number; outputTokens: number; costUsd: number }

export interface WorkstreamAttention { kind: 'question' | 'approval'; text: string; requestId?: string }

export interface WorkstreamDTO {
  id: string
  conversationId: string
  originConversationId: string | null
  goal: string
  state: WorkstreamState
  toolsets: string[]
  budget: WorkstreamBudget
  used: WorkstreamUsed
  attention: WorkstreamAttention | null
  summary: string | null
  failureReason: string | null
  currentRunId: string | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}

export const DEFAULT_WORKSTREAM_BUDGET: WorkstreamBudget = { maxSteps: 400, maxWallMs: 7_200_000 }
/** Bounds for a model- or UI-supplied budget. */
export const BUDGET_LIMITS = { maxSteps: { min: 1, max: 2000 }, maxWallMs: { min: 60_000, max: 24 * 60 * 60 * 1000 } } as const
export const ZERO_USED: WorkstreamUsed = { steps: 0, wallMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
export const TERMINAL_WORKSTREAM_STATES: readonly WorkstreamState[] = ['done', 'failed', 'cancelled']

/** The page a workstream lives at (Task 6). */
export function workstreamPath(id: string): string { return `/workstreams/${id}` }
