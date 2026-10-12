// Cycle 84 Task 2 (spec §2.1 steps 2–3, §2.5): the judge of ONE approval request.
//
// buildAiTools (ai-tools.ts) creates it next to the request and hands it to the run's approval channel
// with the request (`requestApproval(req, { judge })`). The channel publishes its card FIRST and only
// then calls `start()` (controller ruling C3): the rule tier (which may call Gmail) and the LLM judge
// run behind the card, never in front of it. Everything here runs in the run's own process — the
// worker — next to the nonce pin store gmail_send's card writes (tools/gmail.ts), so the gmail rule
// can be bound to the pinned draft revision (bindGmailRuleToPin, fix round 1 R3).
//
// Decisions — first one wins, whoever makes it:
//   - Tony (card / iMessage), the chat 120 s timeout, or Stop: the channel calls settle();
//   - the judge: when the auto-approve predicate (auto-approve.ts) holds at the moment the verdict
//     lands, it asks the channel to resolve the request (`autoApprove`), and the channel reports that
//     back through settle('auto', 'judge') like any other outcome.
// A verdict that lands after a decision is recorded (approval_verdicts) and changes nothing.
// Audit order: the rule-tier row is written before any decision (recordVerdict before recordDecision —
// the decision write waits for the row).
//
// Never auto-approved, whatever the verdict: `humanOnly` tools (decide_review — "Tony confirms every
// call"), headless runs, a surface whose Smart Approvals switch is off, an outbound call in a tainted
// run, a rule floor of high/critical/deny, a gmail_send whose pinned draft is not the revision the
// rule checked (nonce binding), an error/lenient/low-confidence verdict (the predicate's own list).
import type { AgentTool, ApprovalRequest } from '../types'
import { getJudgeSettings, readJudgeSettingsFresh } from '../agent-settings'
import { pinnedSendMessageId } from '../tools/gmail'
import { recordEvent } from '../../observability/record'
import { autoApproveBlocker, type AutoApproveBlocker } from './auto-approve'
import { bindGmailRuleToPin, ruleVerdict } from './rules'
import { recordDecision, recordVerdict } from './store'
import { errorVerdict, judgeVerdict, JUDGE_TIMEOUT_MS, type JudgeInput, type JudgeMessage } from './verdict'
import type {
  ApprovalDecider, ApprovalDecision, ApprovalSurface, ApprovalVerdictDTO, JudgeSettings, JudgeVerdict, RuleVerdict, ToolApprovalNote
} from './types'

/** How long the judge waits for the rule tier before it starts without it (gmail_send's sent-history
 *  lookup can take seconds; every other rule is instant and always makes it into the prompt). */
export const RULE_CONTEXT_WAIT_MS = 2_000
/** Fix round 1 (I2): the rule tier gives up after this long — the floor is then `high` (a hung Gmail
 *  lookup must never leave a workstream `evaluating` forever). */
export const RULE_TIMEOUT_MS = 10_000
/** Fix round 1 (M4): the judge's own bound on a verdict, independent of the verdict seam's timeout. */
export const VERDICT_TIMEOUT_MS = JUDGE_TIMEOUT_MS + 5_000

/** `p`, or `fallback()` once `ms` have passed (the timer never keeps the process alive). */
function withDeadline<T>(p: Promise<T>, ms: number, fallback: () => T, onExpire?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => { onExpire?.(); resolve(fallback()) }, ms)
    timer.unref?.()
  })
  return Promise.race([p, expired]).finally(() => clearTimeout(timer))
}

export interface ApprovalJudgeInit {
  tool: Pick<AgentTool, 'name' | 'description' | 'outbound' | 'humanOnly'>
  /** The call's ORIGINAL args (the rule tier reads them). */
  input: Record<string, unknown>
  /** The card as Tony sees it — the judge judges exactly this (`title` + `command`). */
  req: Pick<ApprovalRequest, 'title' | 'command' | 'logSummary'>
  /** buildAiTools' per-execution approval nonce (the audit key; gmail_send's pin key). */
  nonce: string
  surface: ApprovalSurface
  runId?: string
  workstreamId?: string
  goal?: string | null
  recentMessages?: JudgeMessage[]
  /** The run's taint, read when it matters (it only ever flips on). */
  isTainted: () => boolean
  /** The run's abort signal: Stop cancels a judge still evaluating. */
  signal?: AbortSignal
}

/** Seams (tests swap them; test/setup/judge-off.ts turns the judge off for every other test). */
export interface ApprovalJudgeDeps {
  settings: () => Promise<JudgeSettings>
  /** M1: the settings as stored NOW (uncached) — read again when the decision is made. */
  freshSettings: () => Promise<JudgeSettings>
  /** `signal` aborts the tier's lookups when it is cut off (RULE_TIMEOUT_MS) or the run stops. */
  rule: (tool: Pick<AgentTool, 'name' | 'outbound'>, input: Record<string, unknown>, signal: AbortSignal) => Promise<RuleVerdict>
  verdict: (input: JudgeInput) => Promise<JudgeVerdict>
  ruleTimeoutMs: number
  verdictTimeoutMs: number
  recordVerdict: typeof recordVerdict
  recordDecision: typeof recordDecision
  pinnedSendMessageId: (nonce: string) => string | undefined
  ruleContextWaitMs: number
}
export const defaultApprovalJudgeDeps: Readonly<ApprovalJudgeDeps> = Object.freeze<ApprovalJudgeDeps>({
  settings: getJudgeSettings,
  freshSettings: readJudgeSettingsFresh,
  rule: (tool, input, signal) => ruleVerdict(tool, input, { signal }),
  verdict: input => judgeVerdict(input),
  ruleTimeoutMs: RULE_TIMEOUT_MS,
  verdictTimeoutMs: VERDICT_TIMEOUT_MS,
  recordVerdict,
  recordDecision,
  pinnedSendMessageId,
  ruleContextWaitMs: RULE_CONTEXT_WAIT_MS
})
export const approvalJudgeDeps: ApprovalJudgeDeps = { ...defaultApprovalJudgeDeps }

export interface ApprovalJudge {
  readonly nonce: string
  /**
   * The channel's card is out: begin (idempotent). `autoApprove` resolves the pending request as
   * approved by the judge; the channel then reports it with settle('auto', 'judge'). It is called at
   * most once, and never after settle().
   */
  start(autoApprove: () => void): void
  /** Whether the judge is on (Settings → judge.enabled). Reads the settings once per request. */
  enabled(): Promise<boolean>
  /** Whether Smart Approvals could apply to this call at all (settings, surface, tool, taint). Settles
   *  after start(); false when the judge is off. */
  readonly eligible: Promise<boolean>
  /** Resolves once the judge will not approve this call itself — a human must decide (or already did).
   *  Never resolves when the judge auto-approves. */
  readonly humanNeeded: Promise<void>
  /** What the card shows; null until started, and while the judge is off. */
  view(): ApprovalVerdictDTO | null
  /** Every change of view() (rule landed, verdict landed, auto ruled out). Returns an unsubscribe. */
  onUpdate(fn: (v: ApprovalVerdictDTO) => void): () => void
  /** The approval resolved (first call wins). The channel reports EVERY outcome here. */
  settle(decision: ApprovalDecision, by: ApprovalDecider): void
  /** Set once the judge approved the call (the tool record's "⚖ auto-approved" note). */
  autoNote(): ToolApprovalNote | null
  /** Resolves when every audit write so far has finished (tests, shutdown). */
  writes(): Promise<void>
}

/** A verdict that would pass every verdict clause — to ask "could ANY verdict auto-approve this?". */
const IDEAL: JudgeVerdict = { risk: 'low', recommendation: 'approve', confidence: 1, reasons: [], model: null, latencyMs: 0 }
/** Rule floors the predicate accepts (auto-approve.ts AUTO_FLOORS). */
const AUTO_FLOORS = new Set(['low', 'review'])

function verdictView(v: JudgeVerdict): NonNullable<ApprovalVerdictDTO['verdict']> {
  return { risk: v.risk, recommendation: v.recommendation, confidence: v.confidence, reasons: [...v.reasons], model: v.model, latencyMs: v.latencyMs, ...(v.error !== undefined ? { error: v.error } : {}) }
}

export function createApprovalJudge(init: ApprovalJudgeInit, deps: ApprovalJudgeDeps = approvalJudgeDeps): ApprovalJudge {
  const { tool, nonce } = init
  const gmail = tool.name === 'gmail_send'
  let started = false
  let settled: { decision: ApprovalDecision; by: ApprovalDecider } | null = null
  let view: ApprovalVerdictDTO | null = null
  let note: ToolApprovalNote | null = null
  const listeners = new Set<(v: ApprovalVerdictDTO) => void>()
  let resolveEligible!: (e: boolean) => void
  const eligible = new Promise<boolean>((r) => { resolveEligible = r })
  let resolveHuman!: () => void
  const humanNeeded = new Promise<void>((r) => { resolveHuman = r })
  // true once the rule-tier row exists; false when there will be none (judge off, never started).
  let resolveRow!: (exists: boolean) => void
  const rowReady = new Promise<boolean>((r) => { resolveRow = r })
  let chain: Promise<void> = Promise.resolve()
  const write = (what: string, fn: () => Promise<unknown>) => {
    chain = chain.then(fn).then(() => {}, (err: unknown) => console.error(`[judge] ${what} failed:`, err instanceof Error ? err.message : err))
  }
  const audit = { nonce, runId: init.runId ?? null, workstreamId: init.workstreamId ?? null, tool: tool.name }
  let settingsP: Promise<JudgeSettings | null> | null = null
  const loadSettings = () => (settingsP ??= deps.settings().catch((err: unknown) => {
    console.error('[judge] settings unreadable:', err instanceof Error ? err.message : err)
    return null
  }))

  const emit = () => {
    if (!view) return
    for (const fn of listeners) {
      try { fn(structuredClone(view)) } catch (err) { console.error('[judge] verdict listener failed:', err) }
    }
  }
  const ruleOut = () => {
    if (view?.autoPossible) { view.autoPossible = false; emit() }
    resolveHuman()
  }

  async function run(autoApprove: () => void): Promise<void> {
    const settings = await loadSettings()
    if (settings?.enabled !== true || settled) {
      // Off (or decided before it could begin): no verdict, no audit row, a human decides.
      resolveRow(false)
      resolveEligible(false)
      resolveHuman()
      return
    }
    const s = settings
    const could = tool.humanOnly !== true && autoApproveBlocker({
      settings: s, surface: init.surface, verdict: IDEAL, ruleFloor: 'low',
      outbound: tool.outbound === true, runTainted: init.isTainted(), nonceUnchanged: true
    }) === null
    view = { rule: null, verdict: null, pending: true, autoPossible: could }
    emit()
    resolveEligible(could)
    if (!could) resolveHuman()

    // I2: bounded — a tier that does not answer in time floors `high` and its lookups are aborted.
    const ruleAc = new AbortController()
    const stopRule = () => ruleAc.abort()
    init.signal?.addEventListener('abort', stopRule, { once: true })
    const ruleP: Promise<RuleVerdict> = withDeadline(
      Promise.resolve().then(() => deps.rule(tool, init.input, ruleAc.signal)),
      deps.ruleTimeoutMs, (): RuleVerdict => ({ floor: 'high', reasons: ['rule check timed out'] }), stopRule
    )
      .catch((): RuleVerdict => ({ floor: 'high', reasons: ['rule check failed'] }))
      .finally(() => init.signal?.removeEventListener('abort', stopRule))
      // R3: the recipients checked must be the pinned draft revision's (same process as the pin).
      .then(r => (gmail ? bindGmailRuleToPin(r, deps.pinnedSendMessageId(nonce)) : r))
    void ruleP.then((rule) => {
      // Not on the write chain: a decision queued there waits for this row (rowReady).
      deps.recordVerdict({ ...audit, rule }).then(() => resolveRow(true), (err: unknown) => {
        resolveRow(false)
        console.error('[judge] rule-tier row failed:', err instanceof Error ? err.message : err)
      })
      if (view) { view.rule = { floor: rule.floor, reasons: [...rule.reasons] }; emit() }
      if (!AUTO_FLOORS.has(rule.floor)) ruleOut()
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const ruleForPrompt = await Promise.race([ruleP, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), deps.ruleContextWaitMs) })])
    clearTimeout(timer)
    const verdictStarted = Date.now()
    // M4: the judge's own deadline, whatever the verdict seam does with its timeout.
    const verdict = await withDeadline(
      deps.verdict({
        tool: tool.name, description: tool.description,
        call: [init.req.title, init.req.command].filter(Boolean).join('\n'),
        goal: init.goal ?? null, recentMessages: init.recentMessages, rule: ruleForPrompt, signal: init.signal
      }).catch((err: unknown) => errorVerdict(`judge failed: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`, Date.now() - verdictStarted)),
      deps.verdictTimeoutMs, () => errorVerdict('judge timed out', Date.now() - verdictStarted)
    )
    const rule = await ruleP
    write('verdict', async () => { await rowReady; await deps.recordVerdict({ ...audit, rule, verdict }) })
    if (view) { view.verdict = verdictView(verdict); view.pending = false }

    // The decision, read NOW: taint and the gmail pin may have moved while the judge thought.
    let blocker: AutoApproveBlocker | 'human-only' | 'decided' | null
    // M1: the switches as stored now — turning Smart Approvals off mid-evaluation is honoured.
    const sNow = tool.humanOnly === true || settled ? null : await deps.freshSettings().catch(() => null)
    if (settled) blocker = 'decided'
    else if (tool.humanOnly === true) blocker = 'human-only'
    else if (!sNow) blocker = 'judge-disabled'
    else {
      // The nonce binding, re-read now: gmail_send's card pin must still be the revision checked.
      const pinned = gmail ? deps.pinnedSendMessageId(nonce) : undefined
      blocker = autoApproveBlocker({
        settings: sNow, surface: init.surface, verdict, ruleFloor: rule.floor,
        outbound: tool.outbound === true, runTainted: init.isTainted(),
        nonceUnchanged: !gmail || (!!pinned && pinned === rule.boundMessageId)
      })
    }
    recordEvent({
      kind: 'tool', name: 'judge:verdict', severity: 'info',
      meta: {
        tool: tool.name, runId: audit.runId, workstreamId: audit.workstreamId, surface: init.surface,
        ruleFloor: rule.floor, risk: verdict.risk, recommendation: verdict.recommendation, confidence: verdict.confidence,
        model: verdict.model, latencyMs: verdict.latencyMs, ...(verdict.error !== undefined ? { error: verdict.error } : {}),
        auto: blocker === null, blocker
      }
    })
    if (blocker === null) {
      note = { decidedBy: 'judge', confidence: verdict.confidence, reason: verdict.reasons[0] ?? null }
      emit()
      autoApprove()
      return
    }
    if (view) view.autoPossible = false
    emit()
    resolveHuman()
  }

  return {
    nonce,
    eligible,
    humanNeeded,
    start(autoApprove) {
      if (started) return
      started = true
      run(() => { if (!settled) autoApprove() }).catch((err: unknown) => {
        console.error('[judge] approval judge failed:', err instanceof Error ? err.message : err)
        resolveRow(false)
        resolveEligible(false)
        ruleOut()
      })
    },
    enabled: async () => (await loadSettings())?.enabled === true,
    view: () => (view ? structuredClone(view) : null),
    onUpdate(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    settle(decision, by) {
      if (settled) return
      settled = { decision, by }
      if (by !== 'judge') note = null
      if (!started) { resolveRow(false); resolveEligible(false) }
      ruleOut()
      write('decision', async () => {
        if (await rowReady) await deps.recordDecision(nonce, decision, by)
      })
      if (by === 'judge') {
        recordEvent({
          kind: 'tool', name: 'judge:auto-approve', severity: 'info',
          meta: { tool: tool.name, runId: audit.runId, workstreamId: audit.workstreamId, surface: init.surface, confidence: note?.confidence ?? null, command: init.req.logSummary ?? init.req.command }
        })
      }
    },
    autoNote: () => (settled?.by === 'judge' ? note : null),
    writes: async () => {
      // A write appended while an earlier one ran joins the same chain; loop until it is quiet.
      for (let c = chain; ; c = chain) { await c; if (c === chain) return }
    }
  }
}
