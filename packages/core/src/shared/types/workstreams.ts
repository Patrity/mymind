// Cycle 81 (spec §5): the workstream wire shapes, shared by core and the app (Task 6 UI).
import type { ApprovalVerdictDTO } from '../../lib/agent/judge/types'
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
  /** Cycle 83 final fix wave (I2): a question Tony was texted about — its `#k` handle, unique among
   *  the open questions; a reply starting with `#k` answers this one. */
  tag?: number
  /** Cycle 83 final fix wave (M4): a child's approval / escalated question was listed in a text to
   *  Tony (its tree's grouped away iMessage, or its own interactive approval prompt). */
  awaySent?: true
  /** Cycle 84 fix round 2: approval parked by a drain — the OTHER calls that were still being judged
   *  then (they died with the run too; the approval-lost note names every one). */
  alsoParked?: StoredApprovalRequest[]
  /** Cycle 84: approval — the judge's state for the card (kept current as the verdict lands). Model
   *  output: render as escaped text only. */
  judge?: ApprovalVerdictDTO
}

/** Cycle 83: what a parked coordinator waits for. */
export interface ChildWait { ids: string[]; until: 'all' | 'any'; deadlineAt: number; timeoutMin: number }

export type WorkspaceMode = 'own' | 'shared'

/** Cycle 83 final fix wave (M2): the origin of an event row in a CHILD's thread that its coordinator
 *  wrote (answer_child / steer_workstream) — shown as a "Coordinator" bubble, never as Tony's, and read
 *  by the child's model as `[from your coordinator] …`, never with Tony's user-role authority. */
export const COORDINATOR_ORIGIN = 'coordinator'

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
  /** Cycle 84: while `running` — 'evaluating': the judge is deciding whether a call needs Tony
   *  (Smart Approvals). Null otherwise. */
  stateDetail: WorkstreamStateDetail | null
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
  /** Cycle 83 final fix wave (C2): a CHILD's model as it resolves now — the label of the head of its
   *  chain (its label's model, else the first `subagents` model, else `reasoning`'s); null otherwise
   *  or when the AI config cannot be read. */
  resolvedModel: string | null
  workspaceMode: WorkspaceMode
  /** A coordinator's tree budget (its children's steps — final fix wave I1) and its rolled-up use
   *  (own + every child); null otherwise. */
  treeBudget: TreeBudget | null
  treeUsed: WorkstreamUsed | null
  /** A coordinator's children, oldest first. In the `/api/workstreams` LIST only the children embedded
   *  in that response (at most CHILDREN_IN_LIST, see `childCount`); everywhere else all of them. */
  childIds: string[]
  /** Cycle 83 Task 3 fix round 1: how many children it has in all (0 for a plain workstream). */
  childCount: number
  /** Cycle 83 fix round 1 (I2): a child — even after its coordinator is gone (`parentId` null). */
  isChild: boolean
  /** A run of it read mail/calendar/contacts content. */
  tainted: boolean
  /** Cycle 85: the outcome verifier's latest verdict on a finish_workstream (null: never verified). */
  verification: OutcomeVerification | null
  /** Cycle 85: how many times the verifier sent a finish back (≤ 2; survives segments and restarts). */
  sendBacks: number
}

/** Cycle 84: 'evaluating' — the judge is deciding whether a call needs Tony. Cycle 85: 'verifying' —
 *  the outcome verifier is checking a finish_workstream. Both only while `running`. */
export type WorkstreamStateDetail = 'evaluating' | 'verifying'

export const OUTCOME_VERDICTS = ['met', 'partial', 'unmet'] as const
export type OutcomeVerdictKind = typeof OUTCOME_VERDICTS[number]

/** Cycle 85 (spec §2.3): the outcome verifier's verdict, stored on the row (`workstreams.verification`).
 *  `verdict` null = no usable verdict (`error` says why) — it never blocked the finish. `gaps` and
 *  `nextStep` are MODEL OUTPUT: escaped plain text only. `outcome`: what the verdict did. */
export interface OutcomeVerification {
  verdict: OutcomeVerdictKind | null
  confidence: number
  gaps: string[]
  nextStep: string | null
  error?: string
  model: string | null
  latencyMs: number
  /** `sent-back` (the work continued), `finished` (met), `flagged` (finished after the last send-back,
   *  or on a verifier error), `skipped` (the judge is switched off). */
  outcome: 'sent-back' | 'finished' | 'flagged' | 'skipped'
  /** Send-backs so far, this one included. */
  sendBacks: number
  at: string
}

/** The ⚠ flag the list and the detail show: a finished workstream the verifier did not pass. */
export function verificationFlagged(v: Pick<OutcomeVerification, 'outcome'> | null | undefined): boolean {
  return v?.outcome === 'flagged'
}

export const DEFAULT_WORKSTREAM_BUDGET: WorkstreamBudget = { maxSteps: 400, maxWallMs: 7_200_000 }
/** Cycle 83 (spec D4, amended by the final fix wave I1): a coordinator's tree budget caps its
 *  CHILDREN's steps only, summed — the coordinator's own budget is not inside it, and wall time is not
 *  a tree dimension (each child is bounded by its own maxWallMs, the coordinator by its own budget). */
export interface TreeBudget { maxSteps: number }
export const DEFAULT_TREE_BUDGET: TreeBudget = { maxSteps: 2000 }
/** Bounds for a `treeBudget` passed to start_workstream. */
export const TREE_BUDGET_LIMITS = { maxSteps: { min: 1, max: 10_000 } } as const
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

/** Cycle 83 Task 3 fix round 1 (I1): children embedded per coordinator in the /api/workstreams list
 *  (non-terminal first, newest first); the rest come from GET /api/workstreams/:id/children. */
export const CHILDREN_IN_LIST = 20
/** Page size cap of GET /api/workstreams/:id/children. */
export const CHILDREN_PAGE_MAX = 200

// ── Tree budget formula (spec D4) — the ONE copy: the core's spawn/resume checks and the UI's tree
//    meter both use these, so the meter always shows what spawn sees. ───────────────────────────────

export interface TreeMember { state: WorkstreamState; budget: WorkstreamBudget; used: Pick<WorkstreamUsed, 'steps' | 'wallMs'> }

/** What a tree member holds of its coordinator's tree: a live one its budget (or more, if it ran past
 *  it), an ended one only what it used (the rest went back to the tree). */
export function reservationOf(w: TreeMember): WorkstreamBudget {
  if (TERMINAL_WORKSTREAM_STATES.includes(w.state)) return { maxSteps: w.used.steps, maxWallMs: w.used.wallMs }
  return { maxSteps: Math.max(w.budget.maxSteps, w.used.steps), maxWallMs: Math.max(w.budget.maxWallMs, w.used.wallMs) }
}

/** Committed = every child's reservation, in steps (final fix wave I1: the coordinator's own budget
 *  is outside the tree, and wall time is not a tree dimension). */
export function committedOf(kids: TreeMember[]): TreeBudget {
  return { maxSteps: kids.map(reservationOf).reduce((n, a) => n + a.maxSteps, 0) }
}

/** What is left of the tree for new (or resumed) children. */
export function treeRemaining(tree: TreeBudget, kids: TreeMember[]): TreeBudget {
  return { maxSteps: Math.max(0, tree.maxSteps - committedOf(kids).maxSteps) }
}

/** A tree budget read off a row or a request: only `maxSteps` (an older row may carry maxWallMs —
 *  ignored), clamped to TREE_BUDGET_LIMITS, the default when absent. */
export function normalizeTreeBudget(b: unknown): TreeBudget {
  const v = (b as { maxSteps?: unknown } | null | undefined)?.maxSteps
  const { min, max } = TREE_BUDGET_LIMITS.maxSteps
  return { maxSteps: typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : DEFAULT_TREE_BUDGET.maxSteps }
}
