// app/lib/agent/approvals.ts
// Client-side state for pending approval cards (cycle 79 fix wave, review I1).
//
// The server can have SEVERAL approvals pending at once: the AI SDK executes the tool calls of one
// step concurrently, so two gmail_send / calendar_rsvp calls in one step each raise their own
// `approval` frame. A single "pending approval" slot let the second frame overwrite the first,
// leaving the first card with no details (just `{account, draftId}`) while its Approve still
// resolved the request server-side — Tony could approve an email he never saw. State is therefore
// kept PER REQUEST (keyed by the approval's requestId = the UI part's `approval.id`), each card
// renders from its own entry, and a non-exec card with no entry offers Deny only.
import type { ApprovalVerdictDTO, ToolApprovalNote } from '@mymind/core/lib/agent/judge/types'

export interface PendingApprovalDetails {
  requestId: string
  tool: string
  command: string
  proposedPattern: string
  /** False for tools Tony must confirm every time (decide_review): no "always allow". */
  allowlistable?: boolean
  /** Per-tool card heading (cycle 79 review m1) — e.g. gmail_send's "Send this email?". Falls
   *  back to the generic "Run this?" when absent. */
  title?: string
  /** Cycle 84: the judge's latest state for this card (the `approval-verdict` frame) — a spinner
   *  while pending, then risk / recommendation / reasons. Reasons are model output: plain text. */
  judge?: ApprovalVerdictDTO
  /** Cycle 84: the judge approved it (`approval-resolved` with `decidedBy: 'judge'`). The card
   *  stays on screen as "⚖ auto-approved (0.94)" — no buttons — until the call's result lands. */
  auto?: ToolApprovalNote
}

/** requestId → that request's details. A plain record (not a Map) so Vue tracks it deeply. */
export type PendingApprovals = Record<string, PendingApprovalDetails>

/** A new `approval` frame: add its details WITHOUT touching any other pending request. */
export function addApproval(state: PendingApprovals, d: PendingApprovalDetails): PendingApprovals {
  return { ...state, [d.requestId]: d }
}

/** The request was decided (by Tony here, a timeout, or an abandoned turn): drop only it. */
export function removeApproval(state: PendingApprovals, requestId: string): PendingApprovals {
  if (!(requestId in state)) return state
  const { [requestId]: _gone, ...rest } = state
  return rest
}

/** An `approval-verdict` frame: the latest replaces the earlier, on its OWN card only. A verdict for
 *  a card this page never saw (or already resolved) is dropped — it must not resurrect one. */
export function setApprovalVerdict(state: PendingApprovals, requestId: string, judge: ApprovalVerdictDTO): PendingApprovals {
  const cur = state[requestId]
  if (!cur || cur.auto) return state
  return { ...state, [requestId]: { ...cur, judge } }
}

/** `approval-resolved` decided by the judge: keep the card, flipped to its auto-approved state. Any
 *  other resolution (Tony, a timeout, a cancel) removes it as before. */
export function resolveApproval(
  state: PendingApprovals,
  requestId: string,
  auto?: ToolApprovalNote | null
): PendingApprovals {
  const cur = state[requestId]
  if (cur && auto && auto.decidedBy === 'judge') return { ...state, [requestId]: { ...cur, auto } }
  return removeApproval(state, requestId)
}

/** The details belonging to ONE card (its part's approval.id), or null. */
export function approvalFor(state: PendingApprovals | null | undefined, requestId: string | undefined): PendingApprovalDetails | null {
  if (!state || !requestId) return null
  return state[requestId] ?? null
}

/** Whether a card may offer Approve. exec's args ARE the command, so its input JSON is a faithful
 *  card even without details; every other dangerous tool's args (gmail_send's {account, draftId})
 *  say nothing about what will be sent, so without its details the only safe answer is Deny. */
export function canApprove(toolName: string, details: PendingApprovalDetails | null): boolean {
  if (details?.auto) return false // the judge already approved it — nothing left to decide
  return details !== null || toolName === 'exec'
}

/**
 * Pending approvals that no tool part on screen carries (cycle 81 Task 6) — a workstream's card
 * mirrored into the chat it was started from, or a card re-sent on attach for a run the transcript
 * does not show. The conversation renders these on their own, or they could never be answered.
 */
export function orphanApprovals(
  state: PendingApprovals | null | undefined,
  messages: ReadonlyArray<{ parts: ReadonlyArray<{ type: string; state?: string; approval?: { id: string } }> }>
): PendingApprovalDetails[] {
  const all = Object.values(state ?? {})
  if (!all.length) return []
  const onParts = new Set<string>()
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'dynamic-tool' && p.state === 'approval-requested' && p.approval) onParts.add(p.approval.id)
    }
  }
  // An auto-approved card is no longer waiting on anyone — never re-raise it on its own.
  return all.filter(a => !a.auto && !onParts.has(a.requestId))
}
