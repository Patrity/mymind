// Cycle 84 (spec §2): the approval judge's shared shapes — the instant rule tier's floor, the LLM
// verdict, the Smart Approvals settings. Kept free of imports so the web, the worker and the UI
// DTOs can all use them.

/** The rule tier's floor (spec D4). `critical`/`deny` are never auto-approvable; `high` flags a
 *  call for the judge and for Tony; `review` is the ordinary "a human looks at it"; `low` is
 *  reserved for calls a rule positively recognises as routine. */
export const RULE_FLOORS = ['low', 'review', 'high', 'critical', 'deny'] as const
export type RuleFloor = (typeof RULE_FLOORS)[number]

export interface RuleVerdict {
  floor: RuleFloor
  /** Short, rule-authored reasons — empty for a plain `review`. They may quote call-supplied text
   *  (paths, hosts, addresses), so the judge prompt fences them as untrusted details. */
  reasons: string[]
  /** gmail_send only: the draft message id whose recipients were checked. Task 2 binds it to the
   *  card's nonce pin with bindGmailRuleToPin (fix round 1, R3). */
  boundMessageId?: string | null
}

export const RISKS = ['low', 'medium', 'high', 'critical'] as const
export type Risk = (typeof RISKS)[number]
export const RECOMMENDATIONS = ['approve', 'review', 'deny'] as const
export type Recommendation = (typeof RECOMMENDATIONS)[number]

/** At most this many reasons, each at most REASON_MAX_CHARS (spec §2.2). */
export const MAX_REASONS = 3
export const REASON_MAX_CHARS = 200

/**
 * The LLM tier's verdict (spec §2.2). `reasons` are MODEL OUTPUT — render as escaped text only,
 * never as markup, and never log them alongside the approval `command` body.
 * A verdict with `error` set (timeout, malformed output, no model) carries `risk: null`,
 * `recommendation: 'review'`, `confidence: 0` — it is a "review", never an approval.
 */
export interface JudgeVerdict {
  risk: Risk | null
  recommendation: Recommendation
  confidence: number
  reasons: string[]
  /** The label of the model that answered (null when none did). */
  model: string | null
  latencyMs: number
  error?: string
  /** Set when the verdict came from the lenient text fallback (no structured output). Never
   *  auto-approvable (fix round 1). */
  lenient?: true
}

/** Smart Approvals (spec §2.3). Stored in the agent settings doc under `judge`. */
export interface JudgeSettings {
  /** Run the judge at all (verdicts on cards). Off = no verdicts and no auto-approval. */
  enabled: boolean
  smartApprovals: {
    /** Auto-approve in workstream runs (default on). */
    workstreams: boolean
    /** Auto-approve in chat runs (default off). */
    chat: boolean
  }
  /** Minimum verdict confidence for an auto-approval (default 0.9, 0.5–0.99). */
  confidence: number
}

export const JUDGE_CONFIDENCE_LIMITS = { min: 0.5, max: 0.99 } as const

export const DEFAULT_JUDGE_SETTINGS: Readonly<JudgeSettings> = Object.freeze({
  enabled: true,
  smartApprovals: Object.freeze({ workstreams: true, chat: false }),
  confidence: 0.9
})

/** Where the approval was raised. Headless runs (jobs/wakes) are never auto-approved (spec §2.3). */
export type ApprovalSurface = 'chat' | 'workstream' | 'headless'

/** How an approval was finally resolved, and by whom (spec §2.5). */
export type ApprovalDecision = 'approved' | 'denied' | 'auto' | 'timeout'
export type ApprovalDecider = 'tony' | 'judge' | 'timeout'

/**
 * Cycle 84 Task 2: what an approval card (web card, workstream attention, the `approval-verdict`
 * frame) shows of the judge. `reasons` are MODEL OUTPUT and the rule reasons may quote call text —
 * render both as escaped plain text only.
 */
export interface ApprovalVerdictDTO {
  /** The rule tier's floor; null while it is still running. */
  rule: { floor: RuleFloor; reasons: string[] } | null
  /** The LLM verdict; null while the judge is still evaluating. `error` set = no usable verdict
   *  (timeout, malformed, no model) — it reads as "review". */
  verdict: Pick<JudgeVerdict, 'risk' | 'recommendation' | 'confidence' | 'reasons' | 'model' | 'latencyMs' | 'error'> | null
  /** The judge is still evaluating (a spinner on the card). */
  pending: boolean
  /** Smart Approvals may still approve this call without Tony (the call is eligible and nothing has
   *  ruled it out yet). False once a human is needed. */
  autoPossible: boolean
}

/** Cycle 84 Task 2: an auto-approved call's note — on its tool record (the thread's "⚖ auto-approved
 *  (0.94): reason") and on the card's `approval-resolved` frame. `reason` is model output. */
export interface ToolApprovalNote {
  decidedBy: 'judge'
  confidence: number
  reason: string | null
}
