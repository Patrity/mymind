// Cycle 81 (spec §5): the workstream wire shapes, shared by core and the app (Task 6 UI).
/** `paused` (final review I3): Tony pressed Stop in its thread, or two idle segments in a row (cycle 82:
 *  or it waits on a watch; cycle 83: or a coordinator waits on its children). Unlike `attention` it
 *  never captures an iMessage as an answer and is never nudged; it resumes from the UI (Resume), a
 *  reply in its thread, or Bridget's answer_workstream. */
export type WorkstreamState = 'queued' | 'running' | 'attention' | 'paused' | 'done' | 'failed' | 'cancelled'

export interface WorkstreamBudget { maxSteps: number; maxWallMs: number }

/** Persisted every step. `wallMs` is ACTIVE time: segments executing, minus time parked on an
 *  approval card — attention, queue waits and worker downtime never count (see loop.ts). */
export interface WorkstreamUsed { steps: number; wallMs: number; inputTokens: number; outputTokens: number; costUsd: number }

/** What a card needs to be shown again after a restart (review I1) — the card's own fields plus the
 *  log summary. Args/callId stay out: a restored card is answered, then the model re-issues the call. */
export interface StoredApprovalRequest { tool: string; command: string; proposedPattern: string; allowlistable?: boolean; title?: string; logSummary?: string }

export interface WorkstreamAttention {
  /** `paused` rides with state 'paused' (its text says why); the others with state 'attention'. */
  kind: 'question' | 'approval' | 'paused'
  text: string
  requestId?: string
  /** approval: the segment run that asked, and the request (restorable). */
  runId?: string
  request?: StoredApprovalRequest
  /** When Tony was last told about it (epoch ms) — the 2h "still waiting" nudge (review M1). */
  notifiedAt?: number
  /** "Still waiting" nudges sent this episode — capped at MAX_NUDGES (final review I3). */
  nudges?: number
  /** Cycle 82: `paused` because a segment ended with a watch armed — the watch's result resumes it
   *  (a pause by Stop / idleness is never resumed by a watch). */
  waitingForWatch?: true
  /** Cycle 83: `paused` because a coordinator called wait_for_workstreams — parked (no segment, no
   *  budget) until the wait is satisfied or `deadlineAt` (epoch ms) passes. */
  waitingForChildren?: ChildWait
  /** Cycle 83 (a child's attention): its coordinator has been shown this question / pause already. */
  reported?: true
  /** Cycle 83 (a child's question): Tony was told too (the coordinator was itself waiting on him). */
  escalated?: true
}

/** Cycle 83: what a parked coordinator waits for. */
export interface ChildWait { ids: string[]; until: 'all' | 'any'; deadlineAt: number; timeoutMin: number }

export type WorkspaceMode = 'own' | 'shared'

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
  /** Cycle 83: the coordinator of a child; null for a top-level workstream. */
  parentId: string | null
  /** A child's `subagents` model label (null = the default). */
  modelLabel: string | null
  workspaceMode: WorkspaceMode
  /** A coordinator's tree budget and its rolled-up use (own + every child); null otherwise. */
  treeBudget: WorkstreamBudget | null
  treeUsed: WorkstreamUsed | null
  /** A coordinator's children, oldest first. */
  childIds: string[]
  /** A run of it read mail/calendar/contacts content. */
  tainted: boolean
}

export const DEFAULT_WORKSTREAM_BUDGET: WorkstreamBudget = { maxSteps: 400, maxWallMs: 7_200_000 }
/** Cycle 83 (spec D4): a coordinator's tree — its own steps plus every child's reservation. */
export const DEFAULT_TREE_BUDGET: WorkstreamBudget = { maxSteps: 2000, maxWallMs: 28_800_000 }
/** A child's budget when the coordinator gives none (reserved out of the tree at spawn). */
export const DEFAULT_CHILD_BUDGET: WorkstreamBudget = { maxSteps: 200, maxWallMs: 3_600_000 }
/** Children per spawn_workstreams call (a sanity limit, not a headcount cap). */
export const MAX_SPAWN_PER_CALL = 50
/** Bounds for a model- or UI-supplied budget. */
export const BUDGET_LIMITS = { maxSteps: { min: 1, max: 2000 }, maxWallMs: { min: 60_000, max: 24 * 60 * 60 * 1000 } } as const
export const ZERO_USED: WorkstreamUsed = { steps: 0, wallMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
export const TERMINAL_WORKSTREAM_STATES: readonly WorkstreamState[] = ['done', 'failed', 'cancelled']

/** The page a workstream lives at (Task 6). */
export function workstreamPath(id: string): string { return `/workstreams/${id}` }

/** What Resume adds to a workstream whose budget is used up (one segment's worth of steps and
 *  half an hour of active time), so it can actually move. Shared so the UI can say it up front. */
export const RESUME_EXTENSION = { steps: 40, wallMs: 30 * 60_000 } as const

/** The budget a resumed (failed/cancelled) workstream gets when its budget is used up — before the
 *  BUDGET_LIMITS clamp the loop applies. Never shrinks a dimension. */
export function resumeBudget(b: WorkstreamBudget, used: Pick<WorkstreamUsed, 'steps' | 'wallMs'>): WorkstreamBudget {
  return {
    maxSteps: Math.max(b.maxSteps, used.steps + RESUME_EXTENSION.steps),
    maxWallMs: Math.max(b.maxWallMs, used.wallMs + RESUME_EXTENSION.wallMs)
  }
}
