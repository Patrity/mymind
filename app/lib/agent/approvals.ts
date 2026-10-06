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

/** The details belonging to ONE card (its part's approval.id), or null. */
export function approvalFor(state: PendingApprovals | null | undefined, requestId: string | undefined): PendingApprovalDetails | null {
  if (!state || !requestId) return null
  return state[requestId] ?? null
}

/** Whether a card may offer Approve. exec's args ARE the command, so its input JSON is a faithful
 *  card even without details; every other dangerous tool's args (gmail_send's {account, draftId})
 *  say nothing about what will be sent, so without its details the only safe answer is Deny. */
export function canApprove(toolName: string, details: PendingApprovalDetails | null): boolean {
  return details !== null || toolName === 'exec'
}
