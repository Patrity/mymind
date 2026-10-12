// Interactive approvals across processes (cycle 81, spec §3.4). The run executes in apps/worker; the
// card is rendered by the web. This is the approval channel the RUNNER registers for a run a web
// socket originated (`agent_runs.origin_sink_id`): it publishes the full ApprovalRequest as an
// `approval` frame on the run's own frame stream (the Postgres run-event log), then waits for an
// `approval-decision` command — which the web sends when Tony clicks the card — or for the run's
// abort signal (Stop / `/clear` / drain), or for the timeout.
//
// The frame goes to EVERY socket viewing the thread, not only the origin socket: a socket that
// reconnects (web restart, deploy, network blip) gets a new sink id, and a card targeted at the old
// one would be invisible while the run waits on it. On every attach the web re-sends the thread's
// still-open cards (events.ts openApprovalFrames — a resumed socket's cursor is already past them);
// `approval-resolved` (published on every outcome) removes a card from every tab. Only the card's
// own fields are published (clientApprovalFrame) — args/callId/logSummary stay in this process.
//
// Everything security-relevant stays inside the run's process (cycle 79): the approval NONCE that
// gmail_send / calendar pin their card to is minted by buildAiTools for the call and never leaves
// this process — the web only ever sees a random `requestId` and answers approved/denied for it.
// "Always allow" is decided HERE, from the request this process holds (allowlistable comes from the
// tool definition, never from the web), so a crafted decision cannot save a pattern for a tool that
// isn't allowlistable. Outcomes are logged with `logSummary ?? command` (cycle 79 review I4).
//
// iMessage approvals (a run whose reply goes to a chat, no socket) keep their DB path:
// channels/approvals.ts, chosen by the runner.
//
// Cycle 84 Task 2: a request may come with its judge (judge/approval.ts). The card goes out first;
// then the judge starts, its state streams to the card as `approval-verdict` frames, and when Smart
// Approvals applies it resolves the request itself (`approval-resolved` with `decidedBy: 'judge'`).
// First decision wins — Tony, the timeout, Stop or the judge; every outcome is reported to the judge
// (the audit). While an eligible call is still being judged the request is `evaluating`, not
// `waiting` on Tony: onWaiting(true) (the workstream's attention + iMessage away prompt) fires only
// once the judge says a human is needed.
import { randomUUID } from 'node:crypto'
import type { ApprovalOptions, ApprovalRequest } from '../types'
import type { ApprovalJudge } from '../judge/approval'
import type { ApprovalDecider } from '../judge/types'
import { clientApprovalFrame, type HubFrame } from '../../bus/events'
import type { CommandPayloads } from '../../bus/commands'
import { addApproval, approvalOutcome } from '../../exec/approvals'
import { recordEvent } from '../../observability/record'
import { capArgs, ARGS_WRITE_CAP } from '../tool-history'
import { turnStreamFor } from './approvals'

type Channel = (req: ApprovalRequest, opts?: ApprovalOptions) => Promise<{ approved: boolean }>

/** A chat approval auto-denies after this long (APPROVAL_TIMEOUT_MS overrides, as it always has). */
export function chatApprovalTimeoutMs(): number {
  return Number(process.env.APPROVAL_TIMEOUT_MS ?? 120_000)
}

export interface BusApprovalOptions {
  /** Publishes one frame on the run's stream (the runner's hub, conversation-wide). */
  publish: (frame: HubFrame) => void
  /** The run's abort signal: an aborted run's pending approvals are denied at once, so a run
   *  parked on a card unwinds (and rescues) promptly for Stop and `/clear`. */
  signal?: AbortSignal
  /** Auto-deny after this many ms. `null` = wait until decided or aborted — the hook for
   *  workstreams, whose approvals wait without a timeout (spec §3.4; attention state). Default:
   *  chatApprovalTimeoutMs(). */
  timeoutMs?: number | null
  /** Fired when a request starts / stops waiting on Tony (workstream attention state). `waiting:
   *  false` fires only for a request that fired `true`. Cycle 84: carries the request and its judge. */
  onWaiting?: (requestId: string, waiting: boolean, ctx: { req: ApprovalRequest; judge?: ApprovalJudge }) => void
  /** Cycle 84: fired when a Smart-Approvals-eligible request starts / stops being judged (the
   *  workstream's `evaluating` detail). `false` fires only after `true`. */
  onEvaluating?: (requestId: string, evaluating: boolean, ctx: { req: ApprovalRequest; judge?: ApprovalJudge }) => void
}

interface Pending {
  runId: string
  req: ApprovalRequest
  finish: (approved: boolean, by?: ApprovalDecider) => void
}
const pending = new Map<string, Pending>()

/** The approval channel of one run (see the header). */
export function busApprovalChannel(runId: string, o: BusApprovalOptions): Channel {
  return (req, opts) => new Promise<{ approved: boolean }>((resolve) => {
    const requestId = randomUUID()
    const judge = opts?.judge
    let timer: ReturnType<typeof setTimeout> | null = null
    let done = false
    let waiting = false
    let evaluating = false
    let unsubscribe: (() => void) | null = null
    // C3: Stop, `/clear` and a drain are not Tony's "no" — recorded cancelled / system.
    const onAbort = () => finish(false, 'system')
    function finish(approved: boolean, by: ApprovalDecider = 'tony') {
      if (done) return
      done = true
      pending.delete(requestId)
      if (timer) clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      unsubscribe?.()
      // The audit first (first decision wins there too), then the card's outcome.
      judge?.settle(by === 'judge' ? 'auto' : by === 'timeout' ? 'timeout' : by === 'system' ? 'cancelled' : approved ? 'approved' : 'denied', by)
      const auto = by === 'judge' ? judge?.autoNote() : null
      o.publish({ type: 'approval-resolved', requestId, decidedBy: by, ...(auto ? { auto } : {}) })
      if (evaluating) { evaluating = false; o.onEvaluating?.(requestId, false, { req, judge }) }
      if (waiting) { waiting = false; o.onWaiting?.(requestId, false, { req, judge }) }
      resolve({ approved })
    }
    const startWaiting = () => {
      if (done || waiting) return
      if (evaluating) { evaluating = false; o.onEvaluating?.(requestId, false, { req, judge }) }
      waiting = true
      o.onWaiting?.(requestId, true, { req, judge })
    }
    // Stopped before it could even ask: nothing to show.
    if (o.signal?.aborted) { done = true; judge?.settle('cancelled', 'system'); resolve({ approved: false }); return }
    pending.set(requestId, { runId, req, finish })
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const timeoutMs = o.timeoutMs === undefined ? chatApprovalTimeoutMs() : o.timeoutMs
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        if (done) return
        recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'warn', meta: { outcome: 'timeout', command: req.logSummary ?? req.command } })
        finish(false, 'timeout')
      }, timeoutMs)
    }
    // Only what the card renders goes on the bus / into the event log (fix round 1, M3): the args,
    // callId and logSummary stay here — the decision is made in this process.
    o.publish(clientApprovalFrame({ requestId, ...req }))
    // The tool part's card: capped like the tool-start frame's args, so a huge argument never
    // ships whole to the browser. Emitted into THIS run's turn stream (same process as the run).
    if (req.callId) turnStreamFor(runId)?.emit({ type: 'approval-request', approvalId: requestId, callId: req.callId, name: req.tool, args: req.args && capArgs(req.args, ARGS_WRITE_CAP) })
    if (!judge) { startWaiting(); return }
    // The card is out — now the judge (rule tier + verdict) runs behind it.
    unsubscribe = judge.onUpdate((v) => { if (!done) o.publish({ type: 'approval-verdict', requestId, judge: v }) })
    void judge.eligible.then((e) => {
      if (e && !done && !waiting) { evaluating = true; o.onEvaluating?.(requestId, true, { req, judge }) }
    })
    void judge.humanNeeded.then(startWaiting)
    judge.start(() => finish(true, 'judge'))
  })
}

/**
 * The worker's `approval-decision` command: resolve the pending request `requestId` in THIS
 * process. Returns false when there is none (already resolved, timed out, its run ended, or an
 * unknown id) — the decision is then a no-op, never an error the user sees.
 */
export function decideBusApproval(d: CommandPayloads['approval-decision']): boolean {
  const p = pending.get(d.requestId)
  if (!p) return false
  const outcome = approvalOutcome(d.approved
    ? { kind: 'approve', remember: d.remember === true, pattern: d.pattern, proposedPattern: p.req.proposedPattern }
    : { kind: 'deny' })
  // Never save an "always allow" for a tool that isn't allowlistable (decide_review, gmail_send, a
  // tainted exec): the card hides the option, and this refuses a crafted decision that sends it.
  const remember = outcome.persist && !!outcome.pattern && p.req.allowlistable === true
  if (remember) {
    addApproval({ pattern: outcome.pattern!, tool: p.req.tool }).catch(err => console.error('[exec] persist approval failed:', err))
  } else if (outcome.persist) {
    recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'warn', meta: { outcome: 'remember-refused', tool: p.req.tool, pattern: outcome.pattern } })
  }
  recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'info', meta: { outcome: d.approved ? 'approve' : 'deny', command: p.req.logSummary ?? p.req.command, pattern: remember ? outcome.pattern : null, remembered: remember } })
  p.finish(outcome.approved)
  return true
}

/** Fix round 1 (C3): withdraw a pending request without a decision from Tony — a workstream cancel.
 *  Denied, recorded cancelled / system. False when there is none. */
export function cancelBusApproval(requestId: string): boolean {
  const p = pending.get(requestId)
  if (!p) return false
  recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'info', meta: { outcome: 'cancelled', command: p.req.logSummary ?? p.req.command } })
  p.finish(false, 'system')
  return true
}

/** Request ids still waiting on Tony, for `runId` or all runs (tests, diagnostics). */
export function pendingBusApprovals(runId?: string): string[] {
  return [...pending].filter(([, p]) => !runId || p.runId === runId).map(([id]) => id)
}
