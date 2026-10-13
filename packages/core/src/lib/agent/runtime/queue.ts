// enqueue → DB row; a pump claims runnable rows and executes them. Serialisation per
// conversation is the claim's job (runs.ts); this file only moves work along.
import { activeRunFor, claimNextRun, createRun, finishRun, touchRun, BOOT_ID } from './runs'
import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentRuns } from '../../../db/schema'
import { resolveSession } from './sessions'
import { pushSteer, requeueUnconsumed } from './inbox'
import { abortRun } from './aborts'
import { runTurn } from './runner'
import { maybeSummarizeLater } from './summarize-hook'
import { recoverStale } from './recover'
import { publishChange } from '../../../utils/live-bus'
import { jobsTick, sweepCrashedFires } from '../jobs/tick'
import { dueTaskEvents } from '../jobs/events'
import { onRunFinished } from '../jobs/outcome'
import { noteUserReply } from '../signals/write'
import { deliveriesTick } from '../../channels/outbox'
import { sendCommand } from '../../bus/commands'
import { executionMode } from './execution-mode'
import { discardSegment, nudgeWaitingWorkstreams, onSegmentFinished, onSegmentHandlerFailed, replyToWorkstream, restoreParkedApprovals, sweepStalledWorkstreams, yieldAllSegments } from '../workstreams/loop'
import { workstreamForConversation } from '../workstreams/store'
import type { AgentRun } from '../../../db/schema'
import type { ReplyTo, RunInput, RunOutcome, RunProfile, RunTrigger, SessionKey } from './types'
import { currentEvalScope } from '../../eval/context'

export const HEADLESS_WALL_CLOCK_MS = 300_000
export const ALIVE_BUMP_MS = 10_000

export interface EnqueueRequest {
  sessionKey: SessionKey | 'thread:new'; input: RunInput; trigger: RunTrigger; profile: RunProfile
  wakeReason?: string; modelDefId?: string | null; originSinkId?: string | null
  /** The agent_jobs row this run fires for (cycle 74) — outcome.ts reads it back on finish. */
  jobId?: string | null
  /** Cycle 75: answer this run back over a channel too (an inbound iMessage). Only a NEW run
   *  carries it, and channel input never steers (`noSteer`), so a run's reply_to is fixed when
   *  it is created. */
  replyTo?: ReplyTo | null
  /** Never steer into an active run: always a new queued run (final review C1 ruling). Channel
   *  input sets it: a steer the run never reads is requeued without reply_to/origin, and a steer
   *  into an app turn would text that turn's reply to the phone. The cost: a text sent mid-turn
   *  waits for that turn to finish instead of being merged into it. */
  noSteer?: boolean
}
export interface EnqueueResult {
  runId: string; conversationId: string; steered: boolean; created: boolean
  /** A user message that became its own queued run BEHIND a run already running on the thread
   *  (a headless wake, or a non-plain message behind an interactive one). ws.ts answers it with a
   *  `queued` frame so the client paints the bubble now instead of when the run starts. */
  queuedBehind: boolean
}

type RunFn = (run: AgentRun) => Promise<RunOutcome>

/** Cycle 76: Tony wrote — a `replied` signal for any job message in main still in its window.
 *  noteUserReply itself decides whether the thread is main (the app enqueues main as
 *  `thread:<id>`, iMessage as `main`). Fire-and-forget: never awaited, never thrown into the turn. */
function noteReply(req: EnqueueRequest, conversationId: string, at: Date): void {
  if (req.trigger !== 'user') return
  const opts = req.sessionKey === 'main' ? { mainConversationId: conversationId } : {}
  void noteUserReply({ conversationId, text: req.input.text, at }, opts)
    .catch(err => console.error('[runtime] reply signal failed:', err))
}

export async function enqueue(req: EnqueueRequest, deps: { run?: RunFn; kick?: boolean; pushSteer?: typeof pushSteer } = {}): Promise<EnqueueResult> {
  const doPushSteer = deps.pushSteer ?? pushSteer
  const { conversationId, created } = await resolveSession(req.sessionKey, { titleHint: req.input.text })
  const at = new Date()
  let active: AgentRun | null | undefined
  // Cycle 81 (spec §5.4): a message typed into a workstream's own thread steers its running segment,
  // joins its queued one, or — in attention — answers and starts the next. A finished workstream's
  // thread is an ordinary chat thread again (replyToWorkstream → null).
  if (req.trigger === 'user' && !created) {
    const ws = await workstreamForConversation(conversationId)
    const r = ws ? await replyToWorkstream(ws, req.input) : null
    if (r) {
      noteReply(req, conversationId, at)
      if (!r.steered && deps.kick !== false) kick(deps.run)
      return { runId: r.runId, conversationId, steered: r.steered, created, queuedBehind: false }
    }
  }
  if (req.trigger === 'user' && !created) {
    active = await activeRunFor(conversationId)
    // Steer only into an INTERACTIVE run (Task 8 review ruling): a headless wake is not a
    // conversation Tony is watching live, so his message queues behind it like any other
    // trigger instead of splicing into a background turn he can't see.
    // Steer only PLAIN text (final review I3): a steer is text-only all the way down —
    // pushSteer stores one string and requeueUnconsumed rebuilds text only — so a message
    // carrying attachments or a `/skill` would silently lose them. It queues as its own run
    // instead, behind the busy one, with its full input intact.
    const plain = !req.input.attachments?.length && !req.input.skill
    if (active && active.profile === 'interactive' && plain && !req.noSteer) {
      const steered = await doPushSteer(active.id, conversationId, req.input.text, 'user')
      if (steered) {
        noteReply(req, conversationId, at)
        return { runId: active.id, conversationId, steered: true, created, queuedBehind: false }
      }
      // pushSteer's own atomic check found the run no longer 'running' — it finished in the
      // gap between the read above and the insert. Fall through to createRun: the words are
      // never dropped, they just become a fresh queued run instead of a steer.
    }
  }
  const run = await createRun({
    conversationId, sessionKey: created && req.sessionKey === 'thread:new' ? `thread:${conversationId}` : req.sessionKey,
    trigger: req.trigger, profile: req.profile, input: req.input,
    wakeReason: req.wakeReason ?? null, modelDefId: req.modelDefId ?? null, originSinkId: req.originSinkId ?? null,
    jobId: req.jobId ?? null, replyTo: req.replyTo ?? null
  })
  noteReply(req, conversationId, at)
  if (deps.kick !== false) kick(deps.run)
  return { runId: run.id, conversationId, steered: false, created, queuedBehind: !!active }
}

export async function abortActive(conversationId: string): Promise<boolean> {
  const active = await activeRunFor(conversationId)
  return active ? (abortRun(active.id), true) : false
}

// runId → a promise that resolves once execute() has fully unwound that run: runFn returned
// (so the runner's `finally` rescue has appended whatever it salvaged), finishRun committed and
// unread steers were requeued. Only runs THIS process is executing have one.
const settles = new Map<string, Promise<void>>()

/**
 * Abort the conversation's running turn and wait (bounded) for it to unwind. `/clear` needs
 * this: the aborted run's rescue appends the question + partial reply in its `finally`, and an
 * epoch written before that append would leave those rows in model history — the ordering the
 * legacy socket got for free from s.lock (Task 9 review ruling). A run owned by another process
 * has no settle promise here; it is aborted-by-signal only there, so this returns without waiting.
 */
export async function abortActiveAndWait(conversationId: string, timeoutMs = 10_000): Promise<boolean> {
  const active = await activeRunFor(conversationId)
  if (!active) return false
  abortRun(active.id)
  const settled = settles.get(active.id)
  if (settled) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([settled, new Promise<void>((r) => { timer = setTimeout(r, timeoutMs) })])
    clearTimeout(timer)
  }
  return true
}

/** The worker's `abort` command (cycle 81): abort `runId` and wait (bounded) for THIS process's
 *  execution of it to unwind. `settled` is true once it has (or when this process isn't running it —
 *  then there is nothing here to wait for), false on timeout. */
export async function abortRunAndWait(runId: string, timeoutMs = 10_000): Promise<{ settled: boolean }> {
  abortRun(runId)
  const settled = settles.get(runId)
  if (!settled) return { settled: true }
  let timer: ReturnType<typeof setTimeout> | undefined
  const ok = await Promise.race([settled.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), timeoutMs) })])
  clearTimeout(timer)
  return { settled: ok }
}

/** How long the worker's `abort` command waits for a run to unwind — under the sender's 10s command
 *  timeout (DEFAULT_COMMAND_TIMEOUT_MS), so a slow unwind is reported as `settled: false` (an
 *  answer) rather than as a lost command. */
export const ABORT_COMMAND_WAIT_MS = 8_000

/**
 * The worker's `abort` command (cycle 81, spec §3.5): Stop/barge-in and `/clear`. Aborts `runId`
 * (when that run is still queued or running — a finished run is left alone, never parked in the
 * pre-abort set forever) and the conversation's running run, and waits (bounded) for every run
 * THIS process is executing to unwind: runFn returned (the runner's rescue has appended what it
 * salvaged), finishRun committed. `settled` is honest — `/clear` writes its epoch only on true:
 *   - nothing to abort, or a queued run (it will start already aborted): true;
 *   - a run executing here that unwound within `timeoutMs`: true; one that did not: false;
 *   - a 'running' row this process is NOT executing (another boot's orphan awaiting recovery):
 *     false — nothing here can confirm its rescue has landed.
 */
export async function abortForCommand(
  p: { runId?: string; conversationId?: string; expiresAt?: number },
  timeoutMs = ABORT_COMMAND_WAIT_MS
): Promise<{ settled: boolean; expired?: true }> {
  // A Stop that waited out a worker outage is void (fix round 1, M4): the turn it meant is long
  // over, and aborting now would hit whatever Tony started since.
  if (p.expiresAt !== undefined && Date.now() > p.expiresAt) return { settled: true, expired: true }
  const targets = new Map<string, { status: string; owner: string | null }>()
  if (p.runId) {
    const [r] = await useDb().select({ status: agentRuns.status, owner: agentRuns.owner }).from(agentRuns).where(eq(agentRuns.id, p.runId)).limit(1)
    if (r && (r.status === 'queued' || r.status === 'running')) targets.set(p.runId, r)
  }
  if (p.conversationId) {
    const a = await activeRunFor(p.conversationId)
    if (a) targets.set(a.id, { status: a.status, owner: a.owner })
  }
  const deadline = Date.now() + timeoutMs
  const results = await Promise.all([...targets].map(async ([id, r]) => {
    abortRun(id)
    if (r.status !== 'running') return true
    let settle = settles.get(id)
    // Claimed by THIS boot but execute() not registered yet (the claim's commit and the pump's
    // continuation are a tick apart): give it a moment to appear.
    if (!settle && r.owner === BOOT_ID) {
      for (let i = 0; i < 25 && !settle; i++) {
        await new Promise(res => setTimeout(res, 10))
        settle = settles.get(id)
      }
    }
    // Still nothing to wait on: settled only if the row has meanwhile stopped running.
    if (!settle) return !(await stillRunning(id))
    let timer: ReturnType<typeof setTimeout> | undefined
    const ok = await Promise.race([settle.then(() => true), new Promise<boolean>((res) => { timer = setTimeout(() => res(false), Math.max(0, deadline - Date.now())) })])
    clearTimeout(timer)
    return ok
  }))
  return { settled: results.every(Boolean) }
}
async function stillRunning(id: string): Promise<boolean> {
  const [r] = await useDb().select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, id)).limit(1)
  return r?.status === 'running'
}

// Run ids this process is actively executing right now — claimed, not yet finished. This is
// the process's own ground truth about what it owns; the periodic tick's `recoverStale` call
// excludes these ids so it can never recover a run this same process is still running just
// because an alive_at bump happened to lag (Task 8 review, fix round 1).
const executing = new Set<string>()

/**
 * The liveness check the alive-bump interval performs every ALIVE_BUMP_MS. Broken out as its
 * own function so a test can call it directly instead of waiting 10s for the real timer.
 * `touchRun` is now fenced to `status='running'` (runs.ts) — a `false` result means someone
 * else (another checkout's periodic tick on the shared dev DB, most likely) already marked
 * this run 'interrupted' while this process still thinks it owns it. Task 8 review ruling:
 * abort it here rather than let the turn run to a finishRun that fencing will now just no-op.
 */
export async function checkStillRunning(runId: string): Promise<boolean> {
  const ok = await touchRun(runId)
  if (!ok) {
    console.warn(`[runtime] run ${runId} was marked non-running elsewhere while this process was still executing it — aborting`)
    abortRun(runId)
  }
  return ok
}

// Run ids whose headless wall clock fired. execute() reads it to tell a timeout abort from a
// user abort (Stop / clear), which reach the runner identically through abortRun.
const timedOut = new Set<string>()

async function execute(run: AgentRun, runFn: RunFn, rekick: boolean, wallClockMs = HEADLESS_WALL_CLOCK_MS): Promise<void> {
  executing.add(run.id)
  let settle!: () => void
  settles.set(run.id, new Promise<void>((r) => { settle = r }))
  try {
    const alive = setInterval(() => { checkStillRunning(run.id).catch(err => console.error('[runtime] liveness check failed:', err)) }, ALIVE_BUMP_MS)
    const wall = run.profile === 'headless' ? setTimeout(() => { timedOut.add(run.id); abortRun(run.id) }, wallClockMs) : null
    let outcome: RunOutcome
    try {
      outcome = await runFn(run)
    } catch (err) {
      outcome = { status: 'failed', error: (err as Error).message }
    } finally {
      clearInterval(alive); if (wall) clearTimeout(wall)
    }
    if (outcome.status === 'aborted' && timedOut.has(run.id)) outcome = { ...outcome, timedOut: true }
    const finished = await finishRun(run.id, outcome).catch((err) => { console.error('[runtime] finishRun failed:', err); return false })
    // Cycle 74: a job-fired run writes its job's outcome (spoke/silent/failed, failure streak,
    // auto-disable). Never allowed to break the run's own unwind. Skipped when finishRun was
    // FENCED (final review M11): the row already says 'interrupted' (recovered elsewhere while
    // this process was still running it), so recording spoke/silent here would contradict it.
    if (finished) await onRunFinished(run, outcome).catch(err => console.error('[runtime] job outcome failed:', err))
    // Cycle 81: a workstream segment decides its successor (done / attention / budget / retry …)
    // BEFORE the steer requeue below — Tony's unread words become the next segment's prompt, not a
    // chat turn. Fenced like the job outcome: a recovered row is recovery's to continue.
    if (finished && run.kind === 'workstream') {
      await onSegmentFinished(run, outcome).catch(async (err) => {
        console.error('[runtime] workstream step failed:', err)
        // Counted toward the failure cap (review M8): a transition that throws every time must end.
        await onSegmentHandlerFailed(run, err).catch(e => console.error('[runtime] recording the workstream failure failed:', e))
      })
    } else if (run.kind === 'workstream') discardSegment(run.id) // fenced: recovery continues it (review M6)
    // Every terminal outcome, not only 'aborted' (Task 8 review ruling — overrides spec §4.4's
    // abort-only wording): a steer that arrived during the last step's generation, or in the
    // gap between runFn returning and finishRun committing, is just as unread as one orphaned
    // by an abort. drainSteerFor's UPDATE...WHERE consumed_at IS NULL is atomic, so calling
    // this unconditionally is safe even when recovery (recover.ts) already requeued this same
    // run's steers first — whichever ran first drains them, the other finds nothing left.
    await requeueUnconsumed(run).catch(err => console.error('[runtime] requeueUnconsumed failed:', err))
    publishChange({ resource: 'agentRun', action: 'updated', id: run.id })
    if (rekick) kick(runFn)
  } finally {
    executing.delete(run.id)
    timedOut.delete(run.id)
    settles.delete(run.id)
    settle()
  }
}

/** Cycle 85: the eval runner (lib/eval/runner.ts) drives an attempt's runs itself, inside its
 *  world — never the process pump or the tick. It claims each run with claimNextRun and executes it
 *  here, through the same path a pump uses (finishRun, the workstream successor, steer requeue,
 *  abort's settle-wait, waitForInFlight on drain). Never rekicks. */
export function executeClaimedRun(run: AgentRun, runFn: RunFn): Promise<void> {
  return execute(run, runFn, false)
}

/** Test seam (cycle 81 worker child fixtures): execute a run the caller has ALREADY claimed for
 *  this boot (status 'running', owner BOOT_ID), through the same path a pump uses — so abort's
 *  settle-wait, finishRun and steer requeue behave as in the worker — without pumping the shared
 *  dev DB. Resolves when the run has fully unwound. */
export const _executeClaimedForTests = executeClaimedRun

/** Claim and START everything currently runnable; returns how many were started. */
/** `rekick: false` + `onlyConversations` is the test seam: the dev DB is shared, and an unscoped
 *  re-pump after a test run finishes would claim (and fake-execute) other sessions' queued runs. */
/** `wallClockMs` is a test seam for the headless wall clock (default HEADLESS_WALL_CLOCK_MS). */
export function pumpOnce(opts: { onlyConversations?: string[]; run?: RunFn; rekick?: boolean; wallClockMs?: number } = {}): Promise<number> {
  // Tracked (Task 2 review M1): a pump can be INSIDE claimNextRun when the drain starts — its claim
  // commits after stopClaiming(), and execute() registers the run only then. waitForInFlight awaits
  // every pump still in flight, so that run is waited for, never left 'running' at exit.
  const p = pumpLoop(opts)
  pumps.add(p)
  void p.finally(() => pumps.delete(p)).catch(() => {})
  return p
}
const pumps = new Set<Promise<number>>()

async function pumpLoop(opts: { onlyConversations?: string[]; run?: RunFn; rekick?: boolean; wallClockMs?: number }): Promise<number> {
  const runFn = opts.run ?? ((r: AgentRun) => runTurn(r, { afterPersist: maybeSummarizeLater }))
  let started = 0
  for (;;) {
    // Draining (SIGTERM): never claim another run; what is executing finishes on its own.
    if (claimingStopped) return started
    const run = await claimNextRun({ onlyConversations: opts.onlyConversations })
    if (!run) return started
    started++
    void execute(run, runFn, opts.rekick !== false, opts.wallClockMs)
  }
}

// ── Cycle 81: who executes, and draining ─────────────────────────────────────────────────────
// Execution mode (execution-mode.ts): 'local' — a kick pumps here; 'remote' (the web, always
// since cycle 81 Task 3) — this process never claims; a kick becomes a `kick` command to the worker
// (fire-and-forget — the worker's 5s tick is the net if it is lost).
export { setExecutionMode, executionMode, type ExecutionMode } from './execution-mode'

let claimingStopped = false
/** Drain step 1: stop the tick and never claim again in this process (pumpOnce/kick become no-ops).
 *  Runs already executing are untouched. Irreversible for the process (tests: _resumeClaimingForTests). */
export function stopClaiming(): void {
  claimingStopped = true
  stopWorker()
  // Workstream segments stop after their current step and queue their successor for the next worker
  // (spec §2 "checkpoint workstreams") instead of being interrupted at exit.
  yieldAllSegments()
}
export function claimingIsStopped(): boolean { return claimingStopped }
export function _resumeClaimingForTests(): void { claimingStopped = false }

/** Run ids this process is executing right now. */
export function inFlightRunIds(): string[] { return [...settles.keys()] }

/** Drain step 2: resolves true once every run executing at call time (and any started since) has
 *  fully unwound (finishRun committed, steers requeued), or false at `timeoutMs` with some still
 *  running — those keep their 'running' row and are recovered as interrupted by the next boot
 *  (exclusive) or the 60s stale sweep, the existing recovery semantics. */
export async function waitForInFlight(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // Pumps first (a claim mid-flight becomes a run in `settles`), then the runs; loop until both
    // are empty, since a finishing pump can add runs and a finishing run can rekick (a no-op once
    // claiming stopped).
    const pending: Array<Promise<unknown>> = [...pumps, ...settles.values()]
    if (!pending.length) return true
    const left = deadline - Date.now()
    if (left <= 0) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      Promise.allSettled(pending).then(() => false),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(true), left) })
    ])
    clearTimeout(timer)
    if (timedOut) return settles.size === 0 && pumps.size === 0
  }
}

/** Ask for an immediate pump (the `kick` worker command, enqueue). Returns at once. */
export function kickPump(): void { kick() }

let pumping = false
let again = false
function kick(run?: RunFn): void {
  if (claimingStopped) return
  // Cycle 85 (M2): an eval world never kicks the process pump — it would start Tony's pump in the
  // world's context (draining the tenant while his own kicks coalesce into it). The eval runner
  // drives its attempts itself.
  if (currentEvalScope()) return
  if (executionMode() === 'remote') {
    void sendCommand('kick', {}).catch(err => console.error('[runtime] kick command failed:', err))
    return
  }
  if (pumping) { again = true; return }
  pumping = true
  setImmediate(async () => {
    try { do { again = false; await pumpOnce({ run }) } while (again) }
    catch (err) { console.error('[runtime] pump failed:', err) }
    finally { pumping = false }
  })
}

// The periodic tick's own overlap guard. Independent of `pumping` above: `kick` coalesces
// concurrent *pump* requests into one more pass; `ticking` stops two 5s timer firings (or a
// timer firing while a test calls workerTick directly) from running `recoverStale` twice at
// once, which would just be duplicate work, not a race.
let ticking = false

// The outbox's single-flight guard: the deliveries tick in flight, or null. A slow channel
// (BlueBubbles timing out, Resend hanging) must never hold up the worker tick — recovery, the
// jobs and the pump all run behind it — so the tick STARTS deliveriesTick and moves on; a tick
// that finds one still in flight skips it (the rows it would claim are the in-flight one's, or
// wait 5 s for the next tick).
let delivering: Promise<void> | null = null
type DeliveriesOpts = Parameters<typeof deliveriesTick>[0]

/** Start a deliveries tick unless one is still in flight. Never awaited; true when it started. */
function startDeliveries(opts?: DeliveriesOpts): boolean {
  if (delivering) return false
  delivering = deliveriesTick(opts)
    .then(() => {}, err => console.error('[runtime] deliveries tick failed:', err))
    .finally(() => { delivering = null })
  return true
}

/** Test seam: resolves once the deliveries tick in flight (if any) has finished. */
export async function _deliveriesSettled(): Promise<void> {
  await delivering
}

/**
 * The worker's periodic unit of work: recover anything the previous process left dangling in
 * `onlyConversations`'s scope, then pump. Controller ruling (Task 2 review): boot recovery
 * alone leaves a fast-restart (<60s) window where a dead 'running' row blocks its conversation
 * forever, since `enqueue` steers into whatever `activeRunFor` reports as running — so this
 * must also run on every tick, not only at startup.
 *
 * Test seam: called directly with `onlyConversations` so a DB test can prove the periodic
 * path recovers a stale run without ever touching another session's rows — in that scoped
 * form the follow-up pump is also scoped (`pumpOnce({ onlyConversations, rekick: false })`),
 * never the unscoped `kick()` the production (no-args) tick uses.
 */
export async function workerTick(opts: {
  onlyConversations?: string[]
  /** Test seam (scoped ticks only): also start the outbox, scoped by deliveriesTick's own seams. */
  deliveries?: DeliveriesOpts
} = {}): Promise<boolean> {
  if (ticking) return false
  ticking = true
  try {
    await recoverStale({ onlyConversations: opts.onlyConversations, excludeRunIds: [...executing] })
    if (opts.onlyConversations) {
      await pumpOnce({ onlyConversations: opts.onlyConversations, rekick: false })
      if (opts.deliveries) startDeliveries(opts.deliveries)
    } else {
      // Cycle 74 jobs — production (unscoped) ticks only: a scoped test tick must never claim or
      // fire a real job on the shared dev DB. Each guarded alone so one failing never starves
      // the other, nor the pump below. Fires go through wake(), which kicks the pump itself.
      // The crash sweep goes first, so an `at` job it re-arms fires in this same tick.
      try { await sweepCrashedFires() } catch (err) { console.error('[runtime] jobs crash sweep failed:', err) }
      try { await jobsTick() } catch (err) { console.error('[runtime] jobs tick failed:', err) }
      try { await dueTaskEvents() } catch (err) { console.error('[runtime] task.due events failed:', err) }
      // Cycle 81: a workstream that should be moving but has no segment (a crash between a segment's
      // finish and its successor's insert) gets its next one — the kick below claims it.
      try { await sweepStalledWorkstreams() } catch (err) { console.error('[runtime] workstream sweep failed:', err) }
      // Approval cards parked across a drain/crash come back on this worker (review I1) — the first
      // tick after boot — and a long wait on Tony is re-announced at most every 2h (review M1).
      try { await restoreParkedApprovals() } catch (err) { console.error('[runtime] restoring parked approvals failed:', err) }
      try { await nudgeWaitingWorkstreams() } catch (err) { console.error('[runtime] workstream nudge failed:', err) }
      // Cycle 83: parked coordinators whose wait is satisfied or timed out (a restart re-arms nothing
      // else — the wait is the row), and children whose coordinator ended without the cascade.
      try {
        const { sweepCoordinators } = await import('../workstreams/coordinator')
        await sweepCoordinators()
      } catch (err) { console.error('[runtime] coordinator sweep failed:', err) }
      // Cycle 75 outbox: send due iMessage/email deliveries (unscoped, production ticks only).
      // Started, not awaited (single-flight): a slow send never delays this tick.
      startDeliveries()
      // Cycle 75 inbound catch-up + BlueBubbles health (self-throttled to every 2 min).
      // Imported lazily: inbound.ts imports enqueue from this file, and a static import back would
      // make the two modules' load order matter (a load-order hazard, not a bug today).
      try {
        const { catchUpTick } = await import('../../channels/inbound')
        await catchUpTick()
      } catch (err) { console.error('[runtime] iMessage catch-up failed:', err) }
      kick()
    }
  } catch (err) {
    console.error('[runtime] worker tick failed:', err)
  } finally {
    ticking = false
  }
  return true
}

let timer: ReturnType<typeof setInterval> | null = null
export const WORKER_TICK_MS = 5_000
export function startWorker(): void { if (!timer && !claimingStopped) { timer = setInterval(() => { void workerTick() }, WORKER_TICK_MS); kick() } }
export function stopWorker(): void { if (timer) clearInterval(timer); timer = null }
