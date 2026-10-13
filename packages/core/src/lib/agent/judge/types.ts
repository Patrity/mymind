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
    /** Auto-approve in workstream runs (default OFF — final fix wave M4: Tony turns it on after prod
     *  acceptance). */
    workstreams: boolean
    /** Auto-approve in chat runs (default off). */
    chat: boolean
  }
  /** Minimum verdict confidence for an auto-approval (default 0.9, 0.5–0.99). */
  confidence: number
  /** Final fix wave (I5): judge + guard LLM calls running at once in one process (default 4, 1–16);
   *  the rest queue (judge/limiter.ts). Absent → the default. */
  maxInFlight?: number
}

export const JUDGE_CONFIDENCE_LIMITS = { min: 0.5, max: 0.99 } as const

/** Final fix wave (M4, spec D6 amendment 2026-10-12): Smart Approvals ships OFF on both surfaces — the
 *  judge still runs (verdicts on cards, the output guard); auto-approval is opt-in after acceptance. */
export const DEFAULT_JUDGE_SETTINGS: Readonly<JudgeSettings> = Object.freeze({
  enabled: true,
  smartApprovals: Object.freeze({ workstreams: false, chat: false }),
  confidence: 0.9,
  maxInFlight: 4
})

/** Where the approval was raised. Headless runs (jobs/wakes) are never auto-approved (spec §2.3). */
export type ApprovalSurface = 'chat' | 'workstream' | 'headless'

/** How an approval was finally resolved, and by whom (spec §2.5). */
/** Fix round 1 (C3): `cancelled`/`system` — Stop, `/clear`, a drain, a workstream cancel, or no way to
 *  ask at all. Not Tony's denial: calibration data (step 6) must never count these as his "no". */
/** Final fix wave (M2): `lost` / `system` — closed at the next worker boot: the run died with its
 *  process (a crash) before anything decided it. */
export type ApprovalDecision = 'approved' | 'denied' | 'auto' | 'timeout' | 'cancelled' | 'lost'
export type ApprovalDecider = 'tony' | 'judge' | 'timeout' | 'system'

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
  /** Task 4 fix round 0 (C2): why the run is tainted when the call was judged — the card's "run
   *  tainted" chip. Absent or empty: the run was clean. */
  taint?: TaintSource[]
}

/** Cycle 84 Task 2: an auto-approved call's note — on its tool record (the thread's "⚖ auto-approved
 *  (0.94): reason") and on the card's `approval-resolved` frame. `reason` is model output. */
export interface ToolApprovalNote {
  decidedBy: 'judge'
  confidence: number
  reason: string | null
}

/** Cycle 84 Task 3 (spec §3.1): which kind of untrusted content a tool returns — the tools carrying
 *  `AgentTool.guard` have their results scanned for prompt injection. */
export type GuardSource = 'web' | 'mail' | 'workspace' | 'child'

/**
 * Cycle 84 Task 3 (spec §3.3): a tool result the output guard flagged — the `output_warning` run event
 * (a `data-output_warning` part keyed by the call) and the same object on the call's tool record, so
 * the chip survives a reload. `reasons` are plain text: the checker's fixed labels plus, when the
 * classifier flagged it, its own reasons (MODEL OUTPUT — escaped text only). `llm` is present when
 * the classifier answered.
 */
export interface OutputWarningDTO {
  toolCallId: string
  source: GuardSource
  reasons: string[]
  score: number
  llm?: { confidence: number }
  /** Final follow-up: a fail-closed flag (the check could not run) — taints the run `unverified`. */
  unverified?: true
}

/**
 * Task 4 fix round 0 (C1/C2): why a run is tainted. `mail` — a Google mail / calendar / contacts read
 * (79b); `flagged` — the output guard flagged a result as aimed at the agent (cycle 84 §3.3);
 * `workspace` — a workspace that handled untrusted content (cycle 82).
 */
export type TaintSource = 'mail' | 'flagged' | 'child' | 'workspace' | 'unverified'
/** Display / prompt order: the most specific reason first. Final follow-up: `unverified` — the guard
 *  could not check a result (timeout, slot wait expired, judge down) and failed closed. Run-only. */
export const TAINT_SOURCES: readonly TaintSource[] = ['flagged', 'mail', 'child', 'workspace', 'unverified']
/** Final follow-up (rulings N1/N2): the only sources ever persisted on a workstream row (and inherited
 *  by work it starts): a mail/calendar read, `flagged` from a REAL verdict, and (follow-up 2, NB2)
 *  `child` — a coordinator read output from a child whose row or workspace is tainted. `workspace` is
 *  derived live from the workspace's own flag; `unverified` lives and dies with its run. */
export const PERSISTED_TAINT_SOURCES: readonly TaintSource[] = ['flagged', 'mail', 'child']
export function persistableTaint(sources: readonly string[] | null | undefined): TaintSource[] {
  return PERSISTED_TAINT_SOURCES.filter(x => sources?.includes(x))
}
/** Final follow-up: a run whose only taint is `unverified` runs workspace commands offline WITHOUT
 *  marking the workspace tainted. */
export function onlyUnverified(sources: readonly TaintSource[]): boolean {
  return sources.length > 0 && sources.every(x => x === 'unverified')
}

/** One guard flag that tainted the run. `reasons` include classifier text — MODEL OUTPUT steered by
 *  the flagged content: fenced as untrusted in the judge prompt, escaped text in the UI. */
export interface TaintFlag { tool: string; source: GuardSource; reasons: string[] }

/** The run's taint as the judge reads it. Empty `sources` = clean. */
export interface RunTaint { sources: TaintSource[]; flags: TaintFlag[] }

/** Final fix wave (I2): one earlier tool call of THIS run, as the judge reads it — never its result.
 *  `args` is a short (≤ RUN_CALL_ARGS_CHARS) summary of the masked args: model-chosen text, fenced as
 *  untrusted. `guard`: the call returns untrusted content of this kind; `flagged`: the guard flagged it. */
export interface RunCall { tool: string; args: string; guard?: GuardSource; flagged?: boolean }
export const RUN_CALL_ARGS_CHARS = 120
