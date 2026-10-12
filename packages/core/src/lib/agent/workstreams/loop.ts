// Cycle 81 (spec §5.2–5.4): the workstream state machine.
//
// A workstream advances in SEGMENTS: each is one agent_runs row (kind='workstream', profile
// 'interactive', no socket) on the workstream's own thread, executed by the ordinary queue/runner
// with up to SEGMENT_MAX_STEPS model steps over the thread's persisted history. When a segment ends,
// `onSegmentFinished` (queue.ts execute, after finishRun) decides what happens next:
//   finish_workstream called → done (the tool already posted the summary + notified);
//   ask_tony called          → attention {question}; the next segment starts on Tony's reply;
//   Stop pressed in the thread, or two idle segments in a row
//                            → paused (final review I3): no iMessage capture, no nudges; resumes
//                              from the UI or a reply in the thread;
//   wait_for_workstreams     → paused {waitingForChildren} (cycle 83, coordinator.ts): parked for
//                              free until its children finish / need it, or the wait times out;
//   cancel                   → cancelled (the segment stopped after its current step);
//   budget used up           → one final, tool-free summary segment, then failed (reason kept);
//   segment failed           → retried; the 3rd consecutive failure → failed (never a loop);
//   otherwise                → the next segment is enqueued.
// A crash-interrupted segment (recovery, recover.ts) is re-enqueued from the persisted thread; it
// counts toward the failure streak only when the previous segment was interrupted too.
//
// BUDGET is enforced across segments and restarts: `used` is persisted after every step, and each
// segment's caps (steps, wall clock) are what is LEFT of the budget. Wall clock is ACTIVE time — a
// segment executing, minus time parked on an approval card. Attention (waiting for Tony), queue
// waits and worker downtime never count: a workstream must not burn its budget while nobody can act.
//
// This module never imports the queue or the runner (they import it); a kick is a dynamic import.
// Constants the tool schemas need at load time live in shared/types/workstreams.ts (a leaf): the
// tools module is reached from here through a cycle (notify → channels → queue → runner → profile).
import { and, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentRuns, channelApprovals, conversationMessages, conversations, workstreamQuestionTags, workstreams, type AgentRun } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import { recordEvent } from '../../observability/record'
import { createRun } from '../runtime/runs'
import { abortRun } from '../runtime/aborts'
import { drainCoordinatorFor, drainReportsFor, drainSteerFor, pushSteer } from '../runtime/inbox'
import { busApprovalChannel, cancelBusApproval, decideBusApproval, pendingBusApprovals } from '../runtime/bus-approvals'
import { createRunEventWriter, type HubFrame, type RunEventWriter } from '../../bus/events'
import { APPROVAL_WITHDRAWN, type ImessageApprovalResult } from '../../channels/approvals'
import { parseToolsetIds } from '../toolsets'
import type { ApprovalOptions, ApprovalRequest } from '../types'
import { TAINT_SOURCES, type ApprovalVerdictDTO, type TaintSource } from '../judge/types'
import type { StepUsage } from '../run'
import type { WorkstreamPromptInfo } from '../prompt'
import type { RunInput, RunOutcome } from '../runtime/types'
import {
  BUDGET_LIMITS, COORDINATOR_ORIGIN, DEFAULT_WORKSTREAM_BUDGET, TERMINAL_WORKSTREAM_STATES, normalizeTreeBudget, resumeBudget, ZERO_USED, type ChildWait, type StoredApprovalRequest, type TreeBudget, type WorkstreamAttention,
  type WorkstreamBudget, type WorkstreamDTO, type WorkstreamUsed
} from '../../../shared/types/workstreams'
import {
  addWorkstreamTaint, budgetOf, exhausted, getWorkstream, patchAttentionJudge, patchWorkstream, publishWorkstream, rollupTree, storedTaintSources, usedOf,
  workstreamDTO, workstreamForConversation, workstreamWorkspaceTainted, type WorkstreamRow
} from './store'
import { promptInfo, segmentOrigin, segmentText, type SegmentWhy } from './prompt'
import { noteOrigin, notifyTony, workstreamNotifyDeps } from './notify'
import { ensureWorkstreamWorkspace } from '../../sandbox/store'
import { takeWorkstreamWatchResults, untakeWatchResults, workstreamHasArmedWatch, workstreamHasWatchResults } from '../../sandbox/watches'
import { stepCostUsd } from './cost'
import { segmentPrimaryModelId } from '../runtime/pools'

// Cycle 83: the top-level cap of 3 (MAX_ACTIVE_WORKSTREAMS) is gone (spec D3) — a tree's budget and
// the per-model in-flight pools govern fan-out instead.
const coordinator = () => import('./coordinator')
/** A workstream still waiting on Tony is re-announced at most this often (review M1)… */
export const NUDGE_EVERY_MS = 2 * 60 * 60 * 1000
/** …and at most this many times per attention episode (final review I3): never all night. */
export const MAX_NUDGES = 3
/** Two consecutive segments with no tool call and no finish_workstream → ask Tony (review M3). */

/** Model steps per segment (spec §5.2). */
export const SEGMENT_MAX_STEPS = 40
/** Consecutive failed segments that end the workstream. */
export const MAX_CONSECUTIVE_FAILURES = 3
/** A segment that overruns its remaining wall budget by this much (a step that never ends) is aborted. */
export const WALL_HARD_GRACE_MS = 60_000
/** The final summary step's own hard cap. */
export const FINAL_STEP_MAX_MS = 10 * 60_000

type Channel = (req: ApprovalRequest, opts?: ApprovalOptions) => Promise<{ approved: boolean }>
type StopReason = 'finished' | 'attention' | 'cancel' | 'budget' | 'yield' | 'park' | 'wait'
/** Non-terminal: what a reply/resume may move on from. */
const RUNNABLE: Array<WorkstreamRow['state']> = ['queued', 'running', 'attention', 'paused']

function isTerminal(state: WorkstreamRow['state']): boolean { return TERMINAL_WORKSTREAM_STATES.includes(state) }

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.code === '23505' || e?.cause?.code === '23505'
}

export async function kick(): Promise<void> {
  const { kickPump } = await import('../runtime/queue')
  kickPump()
}

export function clampBudget(b: Partial<WorkstreamBudget> | undefined): WorkstreamBudget {
  const clamp = (v: unknown, lim: { min: number; max: number }, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(lim.max, Math.max(lim.min, Math.round(v))) : d
  return {
    maxSteps: clamp(b?.maxSteps, BUDGET_LIMITS.maxSteps, DEFAULT_WORKSTREAM_BUDGET.maxSteps),
    maxWallMs: clamp(b?.maxWallMs, BUDGET_LIMITS.maxWallMs, DEFAULT_WORKSTREAM_BUDGET.maxWallMs)
  }
}

// ── Segments in this process ──────────────────────────────────────────────────────────────────

export interface Segment {
  runId: string
  workstreamId: string
  /** The runner skips the model entirely (the workstream was cancelled/finished while queued). */
  skip: boolean
  /** The tool-free final summary step (budget used up / loop gave up). */
  final: boolean
  maxSteps: number
  promptInfo: WorkstreamPromptInfo
  stop: StopReason | null
  /** Tool calls that completed in this segment (idle-segment detection). */
  toolCalls: number
  /** Model steps this segment took (cycle 82: fewer than maxSteps = the model ended its turn itself). */
  stepsTaken(): number
  shouldStop(): boolean
  onStep(u: StepUsage): void
  /** The run's approval channel: the card on the workstream thread, mirrored into the origin chat,
   *  raced with the iMessage prompt when Tony is away — no timeout (spec §5.4). */
  approvalChannel(o: { publish: (f: HubFrame) => void; signal: AbortSignal }): Channel
  /** Drain while parked on an approval card (review I1): keep the request on the workstream
   *  (attention {approval}), withdraw the iMessage prompt, and abort the run — the next worker
   *  withdraws the card and resumes (restoreParkedApprovals). False when nothing is waiting. */
  park(): boolean
  /** Stop the clocks, persist the final `used`, close the origin mirror. Idempotent. */
  end(): Promise<void>
  /** Cycle 83: wait_for_workstreams armed this — the segment parks for it when it ends. */
  wait: ChildWait | null
  /** Cycle 83: this workstream is a CHILD — its model label (runner: the subagents chain). */
  child: { modelLabel: string | null; workspaceMode: 'own' | 'shared' } | null
  /** Cycle 83 final fix wave (M7): children whose question / pause a TOOL RESULT of this segment
   *  showed (and marked reported) — un-shown again if the segment fails or is aborted (its tool
   *  results may never be persisted, so the model may never durably have seen them). */
  shown: Set<string>
  /** Cycle 84 final fix wave (C1): the taint this segment's run starts with — the workstream's stored
   *  sources plus `workspace` when its workspace is tainted. Taint is sticky for the workstream's whole
   *  life: it never decays out of the history window, across segments, yields, restarts or wakes. */
  initialTaint: TaintSource[]
  /** Cycle 83: a run of this segment became tainted — persisted AT ONCE (C1: not at segment end), as
   *  a union with the stored sources. No sources given: `mail` (the cycle-83 meaning). */
  markTainted(sources?: readonly TaintSource[]): void
  /** Fix round 1 (M7): resolves once the taint bit is on the row — finish_workstream / ask_tony
   *  await it, so a coordinator can never read a child's words before the child counts as tainted. */
  taintSettled(): Promise<void>
}

/** Who Tony sees a workstream as, and where its notes go (cycle 83): a child is shown as
 *  `<coordinator goal> › <child goal>`, and its notes go to the chat its COORDINATOR was started from
 *  — never into the coordinator's own thread (an event row appended mid-segment forks a thread). */
export async function tonyFacing(ws: Pick<WorkstreamRow, 'id' | 'goal' | 'originConversationId' | 'conversationId' | 'parentId' | 'isChild'>, parent?: WorkstreamRow | null): Promise<Pick<WorkstreamRow, 'id' | 'goal' | 'originConversationId' | 'conversationId'>> {
  if (!ws.isChild) return ws
  const p = parent ?? (ws.parentId ? await getWorkstream(ws.parentId) : null)
  return { id: ws.id, conversationId: ws.conversationId, goal: childTitle(p?.goal ?? 'coordinator', ws.goal), originConversationId: p?.originConversationId ?? null }
}

const clipGoal = (g: string, n = 60) => { const one = g.replace(/\s+/g, ' ').trim(); return one.length > n ? `${one.slice(0, n - 1)}…` : one }
/** `<coordinator goal> › <child goal>` (approval card titles, Tony's notes). */
export function childTitle(coordinatorGoal: string, childGoal: string): string {
  return `${clipGoal(coordinatorGoal)} › ${clipGoal(childGoal)}`
}

const active = new Map<string, Segment>()      // runId → segment executing here
const ended = new Map<string, Segment>()       // runId → segment awaiting onSegmentFinished

/** The segment a tool call belongs to (finish_workstream / ask_tony), or undefined (not a workstream run). */
export function segmentForRun(runId: string | undefined): Segment | undefined {
  return runId ? active.get(runId) : undefined
}

/** Drain (SIGTERM): every segment executing here stops after its current step, ends normally, and
 *  the next segment is queued for the next worker — nothing is interrupted mid-step. */
export function yieldAllSegments(): void {
  for (const s of active.values()) {
    // Parked on a card: no step boundary is coming — park instead (it never counts as a failure).
    if (!s.park()) s.stop ??= 'yield'
  }
}

/** finishRun was fenced (another process recovered the row): onSegmentFinished never runs for it
 *  here, so forget the segment — otherwise the stalled sweep would skip its workstream forever. */
export function discardSegment(runId: string): void {
  const s = active.get(runId) ?? ended.get(runId)
  active.delete(runId)
  ended.delete(runId)
  // Close its clocks, iMessage races and origin mirror (fix round 2) — then forget it for good.
  if (s) void s.end().catch(err => console.error('[workstreams] ending a discarded segment failed:', err)).finally(() => ended.delete(runId))
}

/**
 * The runner's first call for a kind='workstream' run (runtime/runner.ts): load the workstream,
 * mark it running, and build the segment's caps, hooks and approval channel.
 */
export async function beginSegment(run: AgentRun): Promise<Segment> {
  let ws = await workstreamForConversation(run.conversationId)
  if (!ws) throw new Error('this workstream no longer exists')
  const skipped = (): Segment => {
    const s = makeSegment(run, ws!, { skip: true, final: false })
    s.stop = 'cancel'
    active.set(run.id, s)
    return s
  }
  if (ws.cancelRequested || isTerminal(ws.state)) return skipped()
  // Budget already gone (e.g. the step that used it up was the last thing before a restart): this
  // segment becomes the final summary step.
  let final = ws.failureReason ?? exhausted(ws)
  // A card parked over a restart that this segment did not come from (Tony replied instead of
  // deciding it): withdrawn — the model can ask again.
  if (attentionOf(ws)?.kind === 'approval') await releaseParked(ws)
  const patched = await patchWorkstream(ws.id, {
    state: 'running', currentRunId: run.id, attention: null, stateDetail: null,
    ...(final && !ws.failureReason ? { failureReason: final } : {})
  }, RUNNABLE)
  if (!patched) return skipped()
  ws = patched
  final = ws.failureReason
  const parent = ws.parentId ? await getWorkstream(ws.parentId) : null
  // C1: sticky taint — the row's sources, plus a tainted workspace (unreadable → tainted).
  const initialTaint = storedTaintSources(ws)
  if (!initialTaint.includes('workspace') && await workstreamWorkspaceTainted(ws)) initialTaint.push('workspace')
  const seg = makeSegment(run, ws, { skip: false, final: !!final, initialTaint: TAINT_SOURCES.filter(x => initialTaint.includes(x)) }, parent)
  active.set(run.id, seg)
  return seg
}

function makeSegment(run: AgentRun, ws: WorkstreamRow, o: { skip: boolean; final: boolean; initialTaint?: TaintSource[] }, parent: WorkstreamRow | null = null): Segment {
  const base = usedOf(ws)
  // Cycle 83: approvals always reach Tony — a child's card is mirrored into the chat its
  // coordinator was started from (not the coordinator's thread), titled `<coordinator> › <child>`.
  const tonyChat = ws.isChild ? parent?.originConversationId ?? null : ws.originConversationId
  // C1: what the row already says (sources only grow) — a write goes out only for a NEW source.
  const taintStored = new Set<TaintSource>(storedTaintSources(ws))
  let taintWrite: Promise<void> = Promise.resolve()
  const budget = budgetOf(ws)
  let steps = 0
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  let activeMs = 0
  let activeSince: number | null = o.skip ? null : Date.now()
  let hardTimer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()
  const costs: Array<Promise<void>> = []
  const waiting = new Map<string, AbortController>()   // approval requestId → its iMessage race
  // Cycle 84 fix round 1 (C2, M2): requests the judge is still deciding (Smart-Approvals-eligible) —
  // `evaluating` lasts while ANY is in flight, and a drain parks them like a card waiting on Tony.
  const evaluating = new Map<string, ApprovalRequest>()
  let mirror: RunEventWriter | null = null
  let done = false
  let parking = false

  const wallNow = () => base.wallMs + activeMs + (activeSince !== null ? Date.now() - activeSince : 0)
  const hardLimit = o.final ? base.wallMs + FINAL_STEP_MAX_MS : budget.maxWallMs + WALL_HARD_GRACE_MS
  const snapshot = (): WorkstreamUsed => ({
    steps: base.steps + steps, wallMs: Math.round(wallNow()), inputTokens: base.inputTokens + inputTokens,
    outputTokens: base.outputTokens + outputTokens, costUsd: base.costUsd + costUsd
  })
  const clearHard = () => { if (hardTimer) clearTimeout(hardTimer); hardTimer = null }
  const armHard = () => {
    clearHard()
    if (activeSince === null || done) return
    hardTimer = setTimeout(() => {
      seg.stop ??= 'budget'
      abortRun(run.id)
    }, Math.max(0, hardLimit - wallNow()))
    hardTimer.unref?.()
  }
  const pause = () => { if (activeSince !== null) { activeMs += Date.now() - activeSince; activeSince = null } clearHard() }
  const resume = () => { if (activeSince === null && !done) { activeSince = Date.now(); armHard() } }

  /** Every write of this segment goes through ONE chain, in issue order (review M2): an attention
   *  set can never land after the clear that followed it. */
  const serial = (fn: () => Promise<unknown>): Promise<void> => {
    chain = chain.then(async () => { await fn() }).catch(err => console.error('[workstreams] segment write failed:', err))
    return chain
  }
  /** Persist `used` (serialized; the newest snapshot wins). Reads back cancel_requested: a cancel sent
   *  from anywhere is seen at the next step even if the command never reached this process. */
  const checkpoint = (): Promise<void> => {
    chain = chain.then(async () => {
      const [r] = await useDb().update(workstreams).set({ used: snapshot(), updatedAt: sql`now()` })
        .where(eq(workstreams.id, ws.id)).returning({ cancel: workstreams.cancelRequested, state: workstreams.state })
      if (r?.cancel) seg.stop ??= 'cancel'
      publishWorkstream(ws.id)
      // Cycle 83: the coordinator's rolled-up tree use (a no-op outside a tree).
      await rollupTree(ws.parentId ?? ws.id)
    }).catch(err => console.error('[workstreams] checkpoint failed:', err))
    return chain
  }

  const seg: Segment = {
    runId: run.id,
    workstreamId: ws.id,
    skip: o.skip,
    final: o.final,
    maxSteps: o.final ? 1 : Math.max(1, Math.min(SEGMENT_MAX_STEPS, budget.maxSteps - base.steps)),
    promptInfo: promptInfo(ws, o.final ? ws.failureReason : null, parent),
    stop: null,
    wait: null,
    shown: new Set(),
    child: ws.isChild ? { modelLabel: ws.modelLabel, workspaceMode: ws.workspaceMode } : null,
    initialTaint: o.initialTaint ?? [],
    markTainted(sources) {
      const add = (sources?.length ? sources : ['mail' as const]).filter(x => !taintStored.has(x))
      if (!add.length) return
      for (const x of add) taintStored.add(x)
      taintWrite = serial(() => addWorkstreamTaint(ws.id, add))
    },
    taintSettled: () => taintWrite,
    toolCalls: 0,
    stepsTaken: () => steps,
    shouldStop() {
      if (seg.stop) return true
      if (o.final) return false
      if (base.steps + steps >= budget.maxSteps || wallNow() >= budget.maxWallMs) seg.stop = 'budget'
      return seg.stop !== null
    },
    onStep(u) {
      steps++
      inputTokens += u.inputTokens ?? 0
      outputTokens += u.outputTokens ?? 0
      costs.push(stepCostUsd(u).then((c) => { costUsd += c }, () => {}))
      void checkpoint()
    },
    approvalChannel({ publish, signal }) {
      const judgeSubs = new Map<string, () => void>() // requestId → its attention's verdict subscription
      const bus = busApprovalChannel(run.id, {
        signal,
        timeoutMs: null, // spec §3.4/§5.4: a workstream approval waits until decided (or the run stops)
        publish: (f) => {
          publish(f)
          // The card shows in the chat it was started from too (spec §5.4): the same frames, on the
          // origin conversation's log under this run's id — so the web's card tracking, re-send on
          // attach (openApprovalFrames: a still-running run) and decision forwarding all just work.
          if ((f.type === 'approval' || f.type === 'approval-verdict' || f.type === 'approval-resolved') && tonyChat) {
            mirror ??= createRunEventWriter(run.id, tonyChat)
            mirror.emit(f)
          }
        },
        // Cycle 84: a Smart-Approvals-eligible call is `evaluating` (still running, no attention, no
        // texts) while the judge decides; onWaiting(true) follows only when a human is needed.
        onEvaluating: (requestId, isEvaluating, { req }) => {
          const before = evaluating.size
          if (isEvaluating) evaluating.set(requestId, req)
          else evaluating.delete(requestId)
          if (parking) return
          // Final fix wave (M3): time spent waiting on the judge is not the workstream's own work — like
          // a wait on Tony, it does not count against the wall budget (the judge has its own deadlines).
          if (evaluating.size) pause()
          else if (!waiting.size) resume()
          if (before === 0 && evaluating.size === 1) void serial(() => patchWorkstream(ws.id, { stateDetail: 'evaluating' }, ['running']))
          else if (before > 0 && evaluating.size === 0) void serial(() => patchWorkstream(ws.id, { stateDetail: null }))
        },
        onWaiting: (requestId, isWaiting, { req, judge }) => {
          if (isWaiting) {
            const race = new AbortController()
            waiting.set(requestId, race)
            pause()
            void checkpoint()
            const text = approvalText(req)
            // The request itself is kept on the row (review I1): a drain or crash can restore the card.
            // Cycle 84: with the judge's state, kept current below as the verdict lands.
            const verdict = judge?.view() ?? null
            const attention: ParkedAttention = { kind: 'approval', text, requestId, runId: run.id, notifiedAt: Date.now(), request: storedRequest(req), ...(verdict ? { judge: verdict } : {}) }
            if (judge) judgeSubs.set(requestId, judge.onUpdate(v => void serial(() => patchAttentionJudge(ws.id, requestId, v))))
            void serial(async () => {
              const row = await patchWorkstream(ws.id, { state: 'attention', attention }, ['running', 'attention'])
              // The chat it came from hears about it too (review M1), not only the card.
              if (row) {
                const who = await tonyFacing(row, parent)
                await noteOrigin(who, `⚙ Workstream waiting for your approval — ${who.goal}\n${text}`)
              }
            })
            // Away: the iMessage prompt too. Whichever answers first decides; the other is withdrawn.
            // Cycle 83 final fix wave (M4): a CHILD's card is part of its tree's ONE away text — its own
            // interactive prompt only when it is the only thing in the tree waiting on Tony (after
            // the attention above is on the row).
            // Cycle 84: the prompt carries the judge's line (read when it is texted).
            const verdictOf = () => judge?.view() ?? null
            if (ws.isChild && ws.parentId) {
              const parentId = ws.parentId
              void serial(async () => {}).then(() => childAwayApproval(parentId, ws.id, run.id, requestId, req, race.signal, verdictOf))
            } else void startAwayApproval(run.id, requestId, req, race.signal, verdictOf)
          } else {
            judgeSubs.get(requestId)?.()
            judgeSubs.delete(requestId)
            waiting.get(requestId)?.abort(APPROVAL_WITHDRAWN)
            waiting.delete(requestId)
            // Parking (drain): leave attention as it is. The card is NOT carried over: the next
            // worker's restoreParkedApprovals withdraws it and resumes with a `segment:approval-lost`
            // note (the action did not run; the model re-issues it and Tony approves a fresh card).
            if (!waiting.size && !parking) {
              resume()
              // M2: another request may still be under evaluation — keep its detail.
              void serial(() => patchWorkstream(ws.id, { state: 'running', attention: null, stateDetail: evaluating.size ? 'evaluating' : null }, ['attention']))
            }
          }
        }
      })
      return (req, opts) => {
        // Cycle 83: a child's card says whose it is — `<coordinator goal> › <child goal>`.
        if (ws.isChild) req = { ...req, title: `${childTitle(parent?.goal ?? 'coordinator', ws.goal)}: ${req.title ?? `Run ${req.tool}?`}` }
        return bus(req, opts)
      }
    },
    park() {
      if ((!waiting.size && !evaluating.size) || done) return false
      parking = true
      seg.stop = 'park'
      // C2: a drain while the judge is still deciding parks the request exactly like a card waiting on
      // Tony — kept on the row (attention {approval}) so the next worker withdraws it and resumes with
      // a `segment:approval-lost` note. No notification: nobody has been asked yet.
      // Fix round 2: EVERY call in flight is recorded — the first as the parked request (unless a card
      // waiting on Tony already is), the rest in `alsoParked`.
      const judged = [...evaluating]
      if (!waiting.size) {
        const [requestId, req] = judged[0]!
        const rest = judged.slice(1)
        const attention: ParkedAttention = {
          kind: 'approval', text: approvalText(req), requestId, runId: run.id, notifiedAt: Date.now(), request: storedRequest(req),
          ...(rest.length ? { alsoParked: rest.map(([, r]) => storedRequest(r)) } : {})
        }
        void serial(() => patchWorkstream(ws.id, { state: 'attention', attention, stateDetail: null }, ['running', 'attention']))
      } else if (judged.length) {
        void serial(async () => {
          const att = attentionOf((await getWorkstream(ws.id)) ?? { attention: null })
          if (att?.kind !== 'approval') return
          await patchWorkstream(ws.id, { attention: { ...att, alsoParked: [...(att.alsoParked ?? []), ...judged.map(([, r]) => storedRequest(r))] }, stateDetail: null }, ['attention'])
        })
      }
      for (const r of waiting.values()) r.abort(APPROVAL_WITHDRAWN)
      abortRun(run.id)
      return true
    },
    async end() {
      if (done) return
      pause()
      done = true
      clearHard()
      for (const r of waiting.values()) r.abort(APPROVAL_WITHDRAWN)
      waiting.clear()
      await Promise.all(costs)
      if (!o.skip) await checkpoint()
      await chain
      if (mirror) await mirror.close().catch(err => console.error('[workstreams] origin mirror flush failed:', err))
      active.delete(run.id)
      ended.set(run.id, seg)
    }
  }
  if (!o.skip) armHard()
  return seg
}

function approvalText(req: ApprovalRequest): string {
  const what = req.logSummary ?? req.command
  const body = what.length > 300 ? `${what.slice(0, 299)}…` : what
  return req.title ? `${req.title}: ${body}` : `Approve ${req.tool}: ${body}`
}

/** M4: a child's card while Tony is away — the tree's grouped text, or (alone in its tree) its own
 *  interactive prompt, raced with the card like a top-level one. */
async function childAwayApproval(parentId: string, childId: string, runId: string, requestId: string, req: ApprovalRequest, signal: AbortSignal, verdict?: () => ApprovalVerdictDTO | null): Promise<void> {
  try {
    if (signal.aborted) return
    if ((await (await coordinator()).announceTreeAway(parentId, { approvalOf: childId })) !== 'interactive' || signal.aborted) return
    const r = await workstreamNotifyDeps.imessageApproval(runId, req, signal, verdict)
    if (!r || signal.aborted) return
    forwardAwayAnswer(requestId, r)
  } catch (err) {
    console.error('[workstreams] iMessage approval failed:', err)
  }
}

/** The mirrored iMessage prompt's outcome reaches the card (fix round 2, corrected):
 *  - Tony's 👍/👎 is his decision;
 *  - the prompt expired unanswered (30 days) → the card closes as cancelled / system;
 *  - the prompt could not ask him (iMessage unavailable, the send failed) → NOTHING is decided: a
 *    workstream approval waits without a timeout, so the web card stays open for Tony to answer in
 *    the app. Only an activity note records the failed prompt. */
function forwardAwayAnswer(requestId: string, r: ImessageApprovalResult): void {
  if (r.approved || r.decidedBy === undefined || r.decidedBy === 'tony') decideBusApproval({ requestId, approved: r.approved })
  else if (r.decidedBy === 'timeout') cancelBusApproval(requestId)
  else recordEvent({ kind: 'tool', name: 'workstream:away-prompt-failed', severity: 'warn', meta: { requestId, decidedBy: r.decidedBy } })
}

async function startAwayApproval(runId: string, requestId: string, req: ApprovalRequest, signal: AbortSignal, verdict?: () => ApprovalVerdictDTO | null): Promise<void> {
  try {
    if (!(await workstreamNotifyDeps.isAway()) || signal.aborted) return
    const r = await workstreamNotifyDeps.imessageApproval(runId, req, signal, verdict)
    // Withdrawn because the card decided first: nothing to do (decideBusApproval would be a no-op).
    if (!r || signal.aborted) return
    forwardAwayAnswer(requestId, r)
  } catch (err) {
    console.error('[workstreams] iMessage approval failed:', err)
  }
}

// ── Starting, continuing, finishing ──────────────────────────────────────────────────────────

/** Queue the next segment. Null when one is already queued or running (the unique index): a
 *  continuation is then redundant, and Tony's words are folded into the queued one. */
export async function enqueueSegment(ws: WorkstreamRow, input: { text: string; eventOrigin?: string; attachments?: RunInput['attachments']; origin?: string }): Promise<string | null> {
  const runInput: RunInput = {
    text: input.text, modality: 'text',
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.eventOrigin ? { eventOrigin: input.eventOrigin } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(ws.toolsets.length ? { toolsets: ws.toolsets } : {})
  }
  try {
    const run = await createRun({
      conversationId: ws.conversationId, sessionKey: `thread:${ws.conversationId}`, trigger: 'user', profile: 'interactive',
      kind: 'workstream', input: runInput,
      // Cycle 83: the segment's primary model — its pool key (runtime/pools.ts) and the runner's first try.
      modelDefId: await segmentPrimaryModelId(ws)
    })
    await patchWorkstream(ws.id, { currentRunId: run.id })
    return run.id
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    if (!input.eventOrigin) await foldIntoQueued(ws, input.text)
    return null
  }
}

export async function enqueueWhy(ws: WorkstreamRow, why: SegmentWhy, detail?: string): Promise<string | null> {
  return enqueueSegment(ws, { text: segmentText(why, ws, detail), eventOrigin: segmentOrigin(why) })
}

/** Imported at call time, as elsewhere in this file (load order). With `tx`: written inside that
 *  transaction (the caller publishes after its commit). */
async function appendEvent(conversationId: string, content: string, origin: string, o: { tx?: Tx } = {}): Promise<void> {
  await (await import('../../../services/conversations')).appendEvent(conversationId, content, origin, o as never)
}

/** Tony's words into the segment that is queued and not yet claimed: they replace a system
 *  continuation prompt (his message is the better next prompt) or are appended to his earlier one.
 *  Cycle 83 fix round 2: a queued REPORT (a coordinator's children, a fired watch) is never replaced
 *  and never mixed with his words — it is written to the thread as its event row NOW, and his words
 *  become the segment's prompt, so they are persisted as HIS user row (report first, then him). */
async function foldIntoQueued(ws: WorkstreamRow, text: string): Promise<string | null> {
  return withQueuedSegment(ws.conversationId, async (run, tx) => {
    const input = run.input as RunInput
    // Final fix wave (M2): a coordinator's words queued as a child's segment are kept the same way.
    if (input.eventOrigin === 'segment:children' || input.eventOrigin === 'segment:watch' || input.eventOrigin === COORDINATOR_ORIGIN) {
      await appendEvent(ws.conversationId, input.text, input.eventOrigin, { tx })
      const { eventOrigin: _drop, ...rest } = input
      await tx.update(agentRuns).set({ input: { ...rest, text } }).where(eq(agentRuns.id, run.id))
    } else if (input.eventOrigin) {
      const { eventOrigin: _drop, ...rest } = input
      await tx.update(agentRuns).set({ input: { ...rest, text } }).where(eq(agentRuns.id, run.id))
    } else {
      await tx.update(agentRuns).set({ input: { ...input, text: `${input.text}\n\n${text}` } }).where(eq(agentRuns.id, run.id))
    }
  })
}

/**
 * Cycle 83 fix round 2: run `fn` against the conversation's QUEUED workstream segment while holding
 * the claim lock (runs.ts claimNextRun takes the same one) — the segment cannot be claimed meanwhile,
 * so a row `fn` appends to the thread lands before the turn reads its leaf. Null when none is queued.
 */
export async function withQueuedSegment(conversationId: string, fn: (run: AgentRun, tx: Tx) => Promise<void>): Promise<string | null> {
  // Fix round 3: everything `fn` writes goes through `tx` — ONE connection. A second pool connection
  // while this holds the claim lock and the run's row lock could wait on a lock this transaction
  // holds (a thread delete cascading to the run), a cycle Postgres cannot see.
  const id = await useDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mymind:agent_runs:claim'))`)
    const [run] = await tx.select().from(agentRuns)
      .where(and(eq(agentRuns.conversationId, conversationId), eq(agentRuns.kind, 'workstream'), eq(agentRuns.status, 'queued'))).limit(1).for('update')
    if (!run) return null
    await fn(run, tx)
    return run.id
  })
  if (id) publishChange({ resource: 'conversation', action: 'updated', id: conversationId })
  return id
}
type Tx = Parameters<Parameters<ReturnType<typeof useDb>['transaction']>[0]>[0]

/**
 * Start a workstream: its own thread (`⚙ <goal>`), the row, and the first segment. Used by the
 * `start_workstream` tool (Bridget) and the UI (Task 6).
 */
export async function startWorkstream(i: {
  goal: string; toolsets?: string[]; budget?: Partial<WorkstreamBudget>; originConversationId?: string | null
  /** Cycle 83 final fix wave (I1): a coordinator's tree budget (its children's steps). */
  treeBudget?: Partial<TreeBudget>
  /** Cycle 84 final fix wave (I1): the starting run's taint — the workstream starts tainted with it
   *  (sticky for its whole life, C1). */
  taint?: readonly TaintSource[]
}, deps: { kick?: boolean } = {}): Promise<WorkstreamDTO> {
  const goal = i.goal.trim()
  if (!goal) throw new Error('a workstream needs a goal')
  const toolsets = parseToolsetIds(i.toolsets ?? [])
  if (i.treeBudget && !toolsets.includes('coordinator')) throw new Error('treeBudget is for a coordinator — include "coordinator" in toolsets (or leave treeBudget out)')
  const ws = await useDb().transaction(async (tx) => {
    const [conv] = await tx.insert(conversations).values({ title: threadTitle(goal) }).returning({ id: conversations.id })
    const [row] = await tx.insert(workstreams).values({
      conversationId: conv!.id, originConversationId: i.originConversationId ?? null, goal, state: 'queued', used: ZERO_USED,
      toolsets, budget: clampBudget(i.budget),
      ...(i.taint?.length ? { tainted: true, taintSources: TAINT_SOURCES.filter(x => i.taint!.includes(x)) } : {}),
      // Cycle 83: started as a coordinator — its tree budget shows from the start (spawn sets the
      // default otherwise: a workstream that loads `coordinator` later).
      ...(toolsets.includes('coordinator') ? { treeBudget: normalizeTreeBudget(i.treeBudget) } : {})
    }).returning()
    return row!
  })
  publishChange({ resource: 'conversation', action: 'created', id: ws.conversationId })
  publishWorkstream(ws.id, 'created')
  // Cycle 82 (spec §3): its workspace exists from the start (the tools would create it on first use
  // anyway — this just makes it visible in the UI at once).
  await ensureWorkstreamWorkspace(ws.id).catch(err => console.error('[workstreams] creating the workspace failed:', err))
  await enqueueWhy(ws, 'start')
  if (deps.kick !== false) await kick()
  return workstreamDTO((await getWorkstream(ws.id)) ?? ws)
}

/** A workstream's own thread title: `⚙ <goal>`, one line, ≤ 70 chars. */
export function threadTitle(goal: string): string {
  const oneLine = goal.trim().replace(/\s+/g, ' ')
  return `⚙ ${oneLine.length <= 70 ? oneLine : `${oneLine.slice(0, 69).trimEnd()}…`}`
}

/** What a message typed into a workstream's thread does (spec §5.4): while a segment runs it is a
 *  steer; while queued it joins the queued segment; in attention (or stalled) it starts the next
 *  segment. Null for a finished workstream — the caller treats it as an ordinary chat turn.
 *  Cycle 83 final fix wave (M2/C4) — `o.from`: the CHILD's coordinator is speaking (answer_child /
 *  steer_workstream), never Tony. Its words are a `coordinator` event row (a "Coordinator" bubble;
 *  `[from your coordinator] …` to the model), never his user row: a steer is spliced into the running
 *  turn, an answer waits for the question turn to end (so it follows the question), a queued segment
 *  gets the row before it is claimed, and otherwise the row is the next segment's prompt. */
export async function replyToWorkstream(ws: WorkstreamRow, input: RunInput, o: { from?: 'coordinator' | 'coordinator-answer' } = {}): Promise<{ runId: string; steered: boolean } | null> {
  if (isTerminal(ws.state)) return null
  const plain = !input.attachments?.length && !input.skill
  for (let attempt = 0; attempt < 3; attempt++) {
    const [seg] = await useDb().select({ id: agentRuns.id, status: agentRuns.status }).from(agentRuns)
      .where(and(eq(agentRuns.conversationId, ws.conversationId), eq(agentRuns.kind, 'workstream'), inArray(agentRuns.status, ['queued', 'running'])))
      .limit(1)
    if (seg?.status === 'running' && plain) {
      if (await pushSteer(seg.id, ws.conversationId, input.text, o.from ?? 'user')) return { runId: seg.id, steered: true }
      continue // it just finished: look again
    }
    if (seg?.status === 'queued' && plain) {
      const id = o.from
        ? await withQueuedSegment(ws.conversationId, async (_run, tx) => { await appendEvent(ws.conversationId, input.text, COORDINATOR_ORIGIN, { tx }) })
        : await foldIntoQueued(ws, input.text)
      if (id) return { runId: id, steered: false }
      continue // claimed meanwhile: steer instead
    }
    // No segment (attention, stalled), or attachments/skill that can't ride a steer: its own segment
    // (with one already there, enqueueSegment folds the text into a queued one instead).
    const runId = o.from
      ? await enqueueSegment(ws, { text: input.text, eventOrigin: COORDINATOR_ORIGIN })
      : await enqueueSegment(ws, { text: input.text, ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(input.origin ? { origin: input.origin } : {}) })
    if (runId) {
      // His message moves the work on: a card parked over a restart is withdrawn (the model can ask again).
      if (!seg) await releaseParked(ws)
      await patchWorkstream(ws.id, { state: 'running', attention: null }, RUNNABLE)
      return { runId, steered: false }
    }
  }
  throw new Error('could not deliver the message to the workstream (it kept changing state) — try again')
}

async function assistantText(messageId: string | undefined): Promise<string | null> {
  if (!messageId) return null
  const [m] = await useDb().select({ content: conversationMessages.content }).from(conversationMessages).where(eq(conversationMessages.id, messageId)).limit(1)
  return m?.content?.trim() || null
}

async function failWorkstream(ws: WorkstreamRow, reason: string, summary: string | null, lastOutcome: string): Promise<void> {
  await releaseParked(ws)
  const row = await patchWorkstream(ws.id, {
    state: 'failed', failureReason: reason, summary, attention: null, finishedAt: new Date(), lastOutcome
  }, RUNNABLE)
  // Cycle 83: a child's failure goes to its coordinator (store → coordinator.ts afterTransition), which decides.
  if (row && !row.isChild) await notifyTony(row, `⚙ Workstream stopped — ${ws.goal}\nReason: ${reason}${summary ? `\n\n${summary}` : ''}`)
}

async function cancelNow(ws: WorkstreamRow, lastOutcome?: string): Promise<void> {
  await releaseParked(ws)
  await patchWorkstream(ws.id, { state: 'cancelled', attention: null, finishedAt: new Date(), ...(lastOutcome ? { lastOutcome } : {}) }, RUNNABLE)
}

function attentionOf(ws: Pick<WorkstreamRow, 'attention'>): WorkstreamAttention | null {
  return (ws.attention as WorkstreamAttention | null) ?? null
}

/** Pause (final review I3): not a question — nothing to answer, so an inbound iMessage never lands
 *  here and no nudge re-announces it. `note` is told to Tony once (the idle case); Stop is his own act. */
async function pauseWorkstream(ws: WorkstreamRow, text: string, lastOutcome: string, note?: string): Promise<void> {
  const row = await patchWorkstream(ws.id, { state: 'paused', attention: { kind: 'paused', text }, lastOutcome }, ['running', 'attention'])
  // A paused child is its coordinator's to handle (it is woken: coordinator.ts), not Tony's.
  if (row && note && !row.isChild) await notifyTony(row, note)
}

/** `tag` (final fix wave I2): the question's `#k` handle — a reply starting with it answers THIS one
 *  when several questions wait on Tony. */
export function questionNote(goal: string, question: string, tag?: number | null): string {
  return `⚙ Workstream needs you — ${goal}\n\n${question}\n\n${replyHint(tag)}`
}

function replyHint(tag?: number | null): string {
  return tag ? `Reply to answer (#${tag} — start your reply with #${tag} when other questions are waiting too).` : 'Reply to answer.'
}

/** What a finished segment never read: Tony's typed words, and (final fix wave M2/C4) what its
 *  coordinator sent it — an answer_child answer always waits for here. */
interface Unread { typed: string[]; coordinator: string[]; any: boolean }
async function drainUnread(runId: string): Promise<Unread> {
  const typed = await drainSteerFor(runId)
  const coordinator = await drainCoordinatorFor(runId)
  return { typed, coordinator, any: typed.length + coordinator.length > 0 }
}

/** The next segment from what a segment never read. Tony's words are its prompt (his user row), the
 *  coordinator's words their own event row before it; the coordinator's words alone are the prompt as
 *  that event row. No segment runs now (every caller is past a segment's end), so a row appended here
 *  never forks the thread; with one already queued, it is written before that segment is claimed. */
async function enqueueUnread(ws: WorkstreamRow, u: Unread): Promise<string | null> {
  const from = u.coordinator.join('\n\n')
  if (u.typed.length) {
    if (from) await appendEvent(ws.conversationId, from, COORDINATOR_ORIGIN)
    return enqueueSegment(ws, { text: u.typed.join('\n\n') })
  }
  return (await enqueueSegment(ws, { text: from, eventOrigin: COORDINATOR_ORIGIN }))
    ?? withQueuedSegment(ws.conversationId, async (_run, tx) => { await appendEvent(ws.conversationId, from, COORDINATOR_ORIGIN, { tx }) })
}

/** After a segment's run has finished (queue.ts execute, after finishRun committed). Returns the
 *  next segment's run id, if one was queued (the caller's re-pump claims it). */
export async function onSegmentFinished(run: AgentRun, outcome: RunOutcome): Promise<string | null> {
  const seg = ended.get(run.id) ?? active.get(run.id)
  if (seg) await seg.end()
  ended.delete(run.id)
  const ws = await workstreamForConversation(run.conversationId)
  // S1: a coordinator's child lifecycle notes that waited for this segment to end land now — before
  // anything below queues the next segment.
  const leftover = ws ? await appendLeftoverReports(run, ws) : { n: 0, childIds: [] }
  if (ws?.treeBudget) await (await coordinator()).flushChildNotes(ws.id).catch(err => console.error('[workstreams] child notes failed:', err))
  if (!ws || isTerminal(ws.state) || seg?.skip) {
    if (ws && seg?.skip && ws.cancelRequested) await cancelNow(ws)
    return null
  }
  const stop = seg?.stop ?? null
  if (ws.cancelRequested || stop === 'cancel') { await cancelNow(ws, outcome.status); return null }
  // Final fix wave (M7): a failed or aborted segment may never have persisted the tool results that
  // showed children's questions — they count as unseen again (a wait re-reports them; a pause that
  // follows escalates them to Tony).
  if (seg?.shown.size && outcome.status !== 'done') await (await coordinator()).unshowReported(ws.id, [...seg.shown])

  // Drained while parked on a card (review I1): the request stays on the row; the next worker
  // restores the card. Not a failure, not an interruption.
  // Follow-up N3: it still waits on Tony (its card) — reports it never read go to him too.
  if (stop === 'park') { await patchWorkstream(ws.id, { lastOutcome: 'parked' }); await unshowLeftover(ws, leftover.childIds); return null }

  // The final summary step ended (or the loop restarted into it): failed, with whatever it wrote.
  if (ws.failureReason) {
    const summary = outcome.status === 'done' ? await assistantText(outcome.assistantMessageId) : null
    await failWorkstream(ws, ws.failureReason, summary, outcome.status)
    return null
  }

  const budgetGone = exhausted(ws) ?? (stop === 'budget' ? 'its budget is used up' : null)
  if (budgetGone) return finalStep(ws, budgetGone, outcome.status)

  // A leftover approval attention (its card is resolved — the segment ended) is stale (review M2).
  let current = ws
  if (ws.state === 'attention' && attentionOf(ws)?.kind === 'approval') {
    current = (await patchWorkstream(ws.id, { state: 'running', attention: null }, ['attention'])) ?? ws
  }

  // Waiting on Tony (ask_tony). Words he sent while the segment was wrapping up ARE the answer.
  if (current.state === 'attention') {
    const unread = await drainUnread(run.id)
    await patchWorkstream(ws.id, { lastOutcome: outcome.status, failures: 0 })
    // Parked (b): reports it never read are rows now, but it waits on Tony, not on them — their
    // questions are not shown yet, so they go to Tony too (escalated).
    if (!unread.any) { await unshowLeftover(ws, leftover.childIds); return null }
    const next = await enqueueUnread(current, unread)
    if (next) await patchWorkstream(ws.id, { state: 'running', attention: null }, RUNNABLE)
    return next
  }

  // Paused DURING the segment by one of its own tools (fix round 1, I2: a watch over the
  // workstream's lifetime caps). It stays paused for Tony; his unread words resume it.
  if (current.state === 'paused') {
    const unread = await drainUnread(run.id)
    await patchWorkstream(ws.id, { lastOutcome: outcome.status })
    if (!unread.any) { await unshowLeftover(ws, leftover.childIds); return null }
    const next = await enqueueUnread(current, unread)
    if (next) await patchWorkstream(ws.id, { state: 'running', attention: null }, RUNNABLE)
    return next
  }

  // Cycle 83: wait_for_workstreams ended the segment — park until the children answer (Tony's
  // unread words first: the model can wait again after reading them).
  if (stop === 'wait' && outcome.status === 'done' && seg?.wait) {
    const unread = await drainUnread(run.id)
    await patchWorkstream(ws.id, { failures: 0, lastOutcome: 'wait' })
    if (unread.any) return enqueueUnread(current, unread)
    // Fix round 3: child reports were steered in but never read (the segment stopped on this very
    // wait) — they are in the thread now, and their questions count as shown: never park on them.
    if (leftover.n) return enqueueWhy(current, 'children', 'Child reports arrived after you called wait_for_workstreams — they are above.')
    // M6: a watch that already fired is delivered first (the model can wait again after reading it).
    if (await workstreamHasWatchResults(ws.id)) {
      const next = await enqueueWatchResults(current)
      if (next !== undefined) return next
    }
    return (await coordinator()).parkForChildren(current, seg.wait)
  }

  if (outcome.status === 'failed') return countFailure(current, run, outcome.error ?? 'unknown error')

  if (outcome.status === 'aborted') {
    // Not cancel, not budget, not a drain: Tony pressed Stop in the thread. Pause, don't lose it.
    const unread = await drainUnread(run.id)
    if (unread.any) {
      await patchWorkstream(ws.id, { lastOutcome: 'aborted' })
      return enqueueUnread(current, unread)
    }
    await pauseWorkstream(current, 'Stopped. Resume it, reply in this thread to continue, or cancel it.', 'aborted')
    await unshowLeftover(ws, leftover.childIds)
    return null
  }

  // Cycle 82 (watches): a fired watch's result is the next segment; a segment that ENDED ITSELF with
  // a watch still armed waits for it (paused, no budget used) instead of continuing.
  const watchNext = await watchContinuation(current, run, seg, stop, outcome, leftover.n)
  if (watchNext !== undefined) return watchNext

  // Idle segments (review M3): no tool call and no finish_workstream. The first gets a nudge prompt;
  // a second in a row means the model believes it is done (or is stuck) — pause and tell Tony once
  // instead of burning the budget on empty segments (a pause, not a question: I3).
  const idle = stop !== 'yield' && (seg?.toolCalls ?? 1) === 0
  if (idle && current.lastOutcome === 'idle') {
    const unread = await drainUnread(run.id)
    if (unread.any) return enqueueUnread(current, unread)
    const why = 'Paused: the last two segments made no progress (no tool calls, no finish). Resume it, reply in its thread with what to do next, or cancel it.'
    await pauseWorkstream(current, why, 'idle', `⚙ Workstream paused — ${current.goal}\n\n${why}`)
    await unshowLeftover(ws, leftover.childIds)
    return null
  }
  await patchWorkstream(ws.id, { failures: 0, lastOutcome: idle ? 'idle' : 'done' })
  return continueWith(current, run, stop === 'yield' ? 'restarted' : idle ? 'idle' : 'continue')
}

/** Cycle 83 fix round 2: child reports steered into this segment that it ended before reading are
 *  written to the thread as their event rows (no segment runs now) — never dropped, never Tony's.
 *  Fix round 3: taken and written in ONE transaction — a failed append leaves them unconsumed (final
 *  fix wave (a): the tick's sweepLeftoverReports writes them). `o.tx`: inside the caller's transaction.
 *  Returns how many were written and the children they report on. */
export async function appendLeftoverReports(run: Pick<AgentRun, 'id'>, ws: Pick<WorkstreamRow, 'conversationId'>, o: { tx?: Tx } = {}): Promise<{ n: number; childIds: string[] }> {
  try {
    const write = async (tx: Tx) => {
      const texts = await drainReportsFor(run.id, { tx })
      for (const text of texts) await appendEvent(ws.conversationId, text, 'segment:children', { tx })
      return texts
    }
    const texts = o.tx ? await write(o.tx) : await useDb().transaction(write)
    if (texts.length && !o.tx) publishChange({ resource: 'conversation', action: 'updated', id: ws.conversationId })
    return { n: texts.length, childIds: [...new Set(texts.flatMap(reportedChildIds))] }
  } catch (err) {
    if (o.tx) throw err
    console.error('[workstreams] leftover child reports failed:', err)
    return { n: 0, childIds: [] }
  }
}

/** The children a report lists (coordinator.ts describe: `(id <uuid>`). */
function reportedChildIds(text: string): string[] {
  return [...text.matchAll(/\(id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)].map(m => m[1]!)
}

/** Parked (b): leftover reports written while the coordinator ended its segment waiting on Tony. */
async function unshowLeftover(ws: WorkstreamRow, childIds: string[]): Promise<void> {
  if (!childIds.length || !ws.treeBudget) return
  await (await coordinator()).unshowReported(ws.id, childIds).catch(err => console.error('[workstreams] un-showing child reports failed:', err))
}

/**
 * Final fix wave (a): child reports left unconsumed on a segment that has ENDED (a failed append in
 * onSegmentFinished — recovery only revisits dead running runs) are written by the tick. Never while
 * a run is running in that thread (a row appended mid-turn forks it); with a segment queued, inside
 * the claim lock (before it is claimed). Their questions then count as unseen again (a wake or an
 * escalation brings them up), unless a segment is about to read the rows. `graceMs` keeps clear of a
 * segment whose own end is still being handled.
 */
export async function sweepLeftoverReports(o: { onlyConversations?: string[]; graceMs?: number } = {}): Promise<number> {
  if (o.onlyConversations && !o.onlyConversations.length) return 0
  const graceSec = Math.round((o.graceMs ?? 30_000) / 1000)
  const scope = o.onlyConversations
    ? sql`and i.conversation_id in (${sql.join(o.onlyConversations.map(id => sql`${id}::uuid`), sql`, `)})`
    : sql``
  const res = await useDb().execute(sql`
    select distinct i.run_id, i.conversation_id from agent_inbox i join agent_runs r on r.id = i.run_id
    where i.source = 'report' and i.consumed_at is null and r.status not in ('queued', 'running')
      and i.created_at < now() - make_interval(secs => ${graceSec})
      ${scope}`)
  let n = 0
  for (const { run_id: runId, conversation_id: conv } of res.rows as Array<{ run_id: string; conversation_id: string }>) {
    if (active.has(runId) || ended.has(runId)) continue
    const ws = await workstreamForConversation(conv)
    if (!ws) continue
    const [live] = await useDb().select({ status: agentRuns.status }).from(agentRuns)
      .where(and(eq(agentRuns.conversationId, conv), inArray(agentRuns.status, ['queued', 'running']))).limit(1)
    if (live?.status === 'running') continue // the next tick
    let r: { n: number; childIds: string[] } = { n: 0, childIds: [] }
    if (live) await withQueuedSegment(conv, async (_run, tx) => { r = await appendLeftoverReports({ id: runId }, ws, { tx }) })
    else r = await appendLeftoverReports({ id: runId }, ws)
    if (!r.n) continue
    n++
    if (live) continue // the queued segment reads them
    publishChange({ resource: 'conversation', action: 'updated', id: conv })
    await unshowLeftover(ws, r.childIds)
  }
  return n
}

/** What a segment waiting on a watch shows (its Resume continues now). */
export const WAITING_FOR_WATCH = 'Waiting for a watch it set — the work resumes by itself when the watch fires or times out. Resume to continue now.'

/**
 * Cycle 82 (spec §4 `watch`): undefined = no watch business, carry on. Only for a segment that ended
 * normally (not cancel / budget / drain / Stop — those paths keep their own rules, and a pending
 * result simply waits for the next boundary). Tony's unread words always go first.
 */
async function watchContinuation(ws: WorkstreamRow, run: AgentRun, seg: Segment | undefined, stop: StopReason | null, outcome: RunOutcome, leftoverReports = 0): Promise<string | null | undefined> {
  if (stop !== null || outcome.status !== 'done') return undefined
  const fired = await workstreamHasWatchResults(ws.id)
  const ownEnd = !!seg && seg.stepsTaken() < seg.maxSteps
  const wait = !fired && ownEnd && await workstreamHasArmedWatch(ws.id)
  if (!fired && !wait) return undefined
  const unread = await drainUnread(run.id)
  await patchWorkstream(ws.id, { failures: 0, lastOutcome: 'done' })
  if (unread.any) return enqueueUnread(ws, unread)
  if (fired) {
    const next = await enqueueWatchResults(ws)
    if (next !== undefined) return next
  }
  if (!await workstreamHasArmedWatch(ws.id)) return continueWith(ws, run, 'continue')
  // Follow-up N1 (the wait path's fix-round-3 guard): child reports were steered in but never read —
  // they are rows now and their questions count as shown, so never park on the watch over them.
  if (leftoverReports) return enqueueWhy(ws, 'children', 'Child reports arrived after your last step — they are above.')
  await patchWorkstream(ws.id, { state: 'paused', attention: { kind: 'paused', text: WAITING_FOR_WATCH, waitingForWatch: true }, lastOutcome: 'watch' }, ['running'])
  // A watch that ended between the check above and the pause found the workstream 'running' and
  // left its result pending — take it now so it is never stranded behind the pause.
  if (await workstreamHasWatchResults(ws.id)) {
    const row = await getWorkstream(ws.id)
    if (row) return (await enqueueWatchResults(row)) ?? null
  }
  return null
}

/** Claim the pending watch results into one `segment:watch` segment. Undefined when there were none
 *  (someone else claimed them); null when a segment already exists (handed back for its boundary). */
async function enqueueWatchResults(ws: WorkstreamRow): Promise<string | null | undefined> {
  const results = await takeWorkstreamWatchResults(ws.id)
  if (!results.length) return undefined
  // Cycle 84 fix round 1 (M4): a watch's output is workspace content — guarded before it becomes the
  // segment's prompt (flagged: the warning first, which taints the segment's run; the workspace too).
  const { guardDeliveredText } = await import('../judge/guard')
  const texts = await Promise.all(results.map(async r => (await guardDeliveredText(r.text, { tool: 'watch', source: 'workspace', workspaceId: r.workspaceId })).text))
  const runId = await enqueueWhy(ws, 'watch', texts.join('\n\n'))
  if (!runId) { await untakeWatchResults(results.map(r => r.id)); return null }
  await patchWorkstream(ws.id, { state: 'running', attention: null }, RUNNABLE)
  return runId
}

/**
 * A watch of this workstream ended (sandbox/runtime.ts). With no segment live and the work moving
 * (running/queued) or waiting for this watch (paused {waitingForWatch}), its result starts the next
 * segment now ('resumed'). Otherwise it stays pending: a live segment's end takes it, and work held
 * by Tony (a question, a card, his Stop) takes it when it next moves — a watch never overrides him.
 */
export async function wakeWorkstreamForWatch(workstreamId: string): Promise<'resumed' | 'pending' | 'gone'> {
  const ws = await getWorkstream(workstreamId)
  if (!ws || isTerminal(ws.state)) return 'gone'
  const att = attentionOf(ws)
  const movable = ws.state === 'running' || ws.state === 'queued' || (ws.state === 'paused' && att?.waitingForWatch === true)
  if (!movable) return 'pending'
  if ([...active.values(), ...ended.values()].some(s => s.workstreamId === ws.id)) return 'pending'
  const [live] = await useDb().select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.conversationId, ws.conversationId), eq(agentRuns.kind, 'workstream'), inArray(agentRuns.status, ['queued', 'running']))).limit(1)
  if (live) return 'pending'
  const runId = await enqueueWatchResults(ws)
  if (!runId) return runId === undefined ? 'resumed' : 'pending'
  await kick()
  return 'resumed'
}

/**
 * A segment's own tool pauses its workstream for Tony (fix round 1, I2: watch caps). The segment
 * stops after its current step and stays paused (onSegmentFinished); Tony is told once. Resume,
 * a reply in the thread or answer_workstream continue it.
 */
export async function pauseWorkstreamForTony(runId: string | undefined, workstreamId: string, why: string): Promise<boolean> {
  const seg = segmentForRun(runId)
  const row = await patchWorkstream(workstreamId, { state: 'paused', attention: { kind: 'paused', text: why }, lastOutcome: 'paused' }, ['running'])
  if (!row) {
    // Cycle 82 final fix wave: already waiting on Tony (an ask_tony question or an approval card) —
    // never overwrite that attention (his answer is what it waits for). The pause note goes into
    // the thread; the segment still stops after this step.
    const ws = await getWorkstream(workstreamId)
    if (!ws || ws.state !== 'attention') return false
    if (seg) seg.stop ??= 'attention'
    const { appendEvent } = await import('../../../services/conversations')
    await appendEvent(ws.conversationId, `⚙ Paused for you — ${why}`, `workstream:${ws.id}`)
    return true
  }
  if (seg) seg.stop ??= 'attention'
  // A child's pause reaches its coordinator instead (coordinator.ts afterTransition).
  if (!row.isChild) await notifyTony(row, `⚙ Workstream paused — ${row.goal}\n\n${why}`)
  return true
}

/** A failed segment (or a failed transition) — retried until the 3rd in a row, then failed. */
async function countFailure(ws: WorkstreamRow, run: AgentRun | null, error: string): Promise<string | null> {
  const failures = ws.failures + 1
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    await patchWorkstream(ws.id, { failures })
    await failWorkstream(ws, `${failures} segments failed in a row (last: ${error})`, null, 'failed')
    return null
  }
  await patchWorkstream(ws.id, { failures, lastOutcome: 'failed' })
  return run ? continueWith(ws, run, 'retry', error) : enqueueWhy(ws, 'retry', error)
}

/**
 * onSegmentFinished itself threw (review M8): the workstream would be left 'running' with no segment,
 * and the stalled sweep would re-enqueue it forever, uncounted. Count it toward the failure cap; at
 * the cap the workstream is failed with a plain write (no notification path that could throw again).
 */
export async function onSegmentHandlerFailed(run: AgentRun, err: unknown): Promise<void> {
  discardSegment(run.id)
  const ws = await workstreamForConversation(run.conversationId)
  if (!ws || isTerminal(ws.state)) return
  const failures = ws.failures + 1
  const message = err instanceof Error ? err.message : String(err)
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    await patchWorkstream(ws.id, { state: 'failed', failures, failureReason: `${failures} segments failed in a row (last: ${message})`, attention: null, finishedAt: new Date(), lastOutcome: 'failed' }, RUNNABLE)
    return
  }
  await patchWorkstream(ws.id, { failures, lastOutcome: 'failed' })
}

/** The next segment: Tony's unread words if there are any, else the system continuation. */
async function continueWith(ws: WorkstreamRow, run: AgentRun, why: SegmentWhy, detail?: string): Promise<string | null> {
  const unread = await drainUnread(run.id)
  if (unread.any) return enqueueUnread(ws, unread)
  return enqueueWhy(ws, why, detail)
}

async function finalStep(ws: WorkstreamRow, reason: string, lastOutcome: string): Promise<string | null> {
  await releaseParked(ws)
  const row = await patchWorkstream(ws.id, { failureReason: reason, lastOutcome, state: 'running', attention: null }, RUNNABLE)
  if (!row) return null
  return enqueueWhy(row, 'budget', reason)
}

/** iMessage approval prompts a dead segment left pending: nothing will ever wait on them again. */
async function expireOrphanPrompts(runId: string): Promise<void> {
  await useDb().update(channelApprovals).set({ status: 'expired', resolvedAt: new Date() })
    .where(and(eq(channelApprovals.runId, runId), eq(channelApprovals.status, 'pending')))
}

/**
 * Recovery (recover.ts) found this segment's run dead — the worker crashed or restarted mid-segment.
 * Re-enqueue from the persisted thread. A first interruption is free; one that follows an
 * interruption counts toward the failure streak (a segment that kills the worker every time must
 * not loop forever). A segment that died PARKED on a card is not an interruption at all (review I1):
 * the card is withdrawn and the work resumed by restoreParkedApprovals.
 */
export async function onSegmentInterrupted(run: AgentRun): Promise<string | null> {
  active.delete(run.id)
  ended.delete(run.id)
  const owner = await workstreamForConversation(run.conversationId)
  const leftover = owner ? await appendLeftoverReports(run, owner) : { n: 0, childIds: [] }
  await expireOrphanPrompts(run.id).catch(err => console.error('[workstreams] expiring orphaned prompts failed:', err))
  const ws = await workstreamForConversation(run.conversationId)
  if (!ws || isTerminal(ws.state)) return null
  if (ws.cancelRequested) { await cancelNow(ws, 'interrupted'); return null }
  const att = attentionOf(ws)
  const waitingOnTony = ws.state === 'attention' && (att?.kind === 'question' || (att?.kind === 'approval' && !!att.request))
  if (waitingOnTony) {
    // Words he sent to the dead segment are his answer (review M7).
    const unread = await drainUnread(run.id)
    if (!unread.any) {
      await patchWorkstream(ws.id, { lastOutcome: att?.kind === 'approval' ? 'parked' : 'interrupted' })
      // Follow-up N3: reports the dead segment never read are rows now; it waits on Tony, so they go to him.
      await unshowLeftover(ws, leftover.childIds)
      return null
    }
    await releaseParked(ws)
    const next = await enqueueUnread(ws, unread)
    if (next) await patchWorkstream(ws.id, { state: 'running', attention: null, lastOutcome: 'interrupted' }, RUNNABLE)
    return next
  }
  const failures = ws.lastOutcome === 'interrupted' ? ws.failures + 1 : ws.failures
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    await patchWorkstream(ws.id, { failures })
    await failWorkstream(ws, `${failures} segments failed in a row (interrupted by restarts)`, null, 'interrupted')
    return null
  }
  const row = await patchWorkstream(ws.id, { failures, lastOutcome: 'interrupted', state: 'running', attention: null }, RUNNABLE)
  if (!row) return null
  if (row.failureReason) return enqueueWhy(row, 'budget', row.failureReason)
  return continueWith(row, run, 'restarted')
}

// ── Parked approval cards (review I1; fix round 2 C1 ruling) ───────────────────────────────────
//
// A card waiting when the worker drains (or dies) is never carried across the restart: its tool
// call died with the run, and an approval is only ever bound to the live call that raised it (the
// cycle-79 nonce/fingerprint pins are minted per call). So the new worker WITHDRAWS the old card —
// no decision path, closed in every tab, its iMessage prompt recorded expired — and resumes the
// workstream with a note that the action did NOT run. A re-issued call goes through the normal gate
// and raises a FRESH card rendered from live content (attention {approval} again).

function storedRequest(req: ApprovalRequest): StoredApprovalRequest {
  return {
    tool: req.tool, command: req.command, proposedPattern: req.proposedPattern,
    ...(req.allowlistable !== undefined ? { allowlistable: req.allowlistable } : {}),
    ...(req.title !== undefined ? { title: req.title } : {}),
    ...(req.logSummary !== undefined ? { logSummary: req.logSummary } : {})
  }
}
type ParkedAttention = WorkstreamAttention

/** Publish card frames for a parked request on the workstream thread and its origin chat. */
async function publishCardFrames(ws: WorkstreamRow, runId: string, frame: HubFrame): Promise<void> {
  for (const cid of [ws.conversationId, (await tonyFacing(ws)).originConversationId]) {
    if (!cid) continue
    const w = createRunEventWriter(runId, cid)
    w.emit(frame)
    await w.close().catch(err => console.error('[workstreams] card frame failed:', err))
  }
}

/** Withdraw a parked card: closed in every tab, its iMessage prompt expired. Nothing can decide it. */
async function releaseParked(ws: WorkstreamRow): Promise<void> {
  const att = attentionOf(ws)
  if (att?.kind !== 'approval' || !att.requestId || !att.runId) return
  await publishCardFrames(ws, att.runId, { type: 'approval-resolved', requestId: att.requestId })
  await expireOrphanPrompts(att.runId).catch(() => {})
}

/**
 * Resume workstreams parked on an approval card across a drain or a crash (C1 ruling): for every
 * workstream in attention {approval} with no segment queued or running (and none executing here),
 * withdraw the old card and queue a segment that says the action did not run and must be re-issued
 * if still needed. Idempotent; run on every production tick (the first one after boot).
 * `onlyConversations` is the test seam.
 */
export async function restoreParkedApprovals(opts: { onlyConversations?: string[] } = {}): Promise<number> {
  if (opts.onlyConversations && !opts.onlyConversations.length) return 0
  const scope = opts.onlyConversations
    ? sql`and w.conversation_id in (${sql.join(opts.onlyConversations.map(id => sql`${id}::uuid`), sql`, `)})`
    : sql``
  const res = await useDb().execute(sql`
    select w.id from workstreams w
    where w.state = 'attention' and w.attention->>'kind' = 'approval'
      and not exists (select 1 from agent_runs r where r.conversation_id = w.conversation_id
                      and r.kind = 'workstream' and r.status in ('queued', 'running'))
      ${scope}`)
  let n = 0
  for (const { id } of res.rows as Array<{ id: string }>) {
    if ([...active.values(), ...ended.values()].some(s => s.workstreamId === id)) continue
    const ws = await getWorkstream(id)
    const att = ws ? attentionOf(ws) : null
    if (!ws || att?.kind !== 'approval') continue
    await releaseParked(ws)
    const row = await patchWorkstream(ws.id, { state: 'running', attention: null }, ['attention'])
    if (!row) continue
    // Fix round 2: every action that died with the run is named (a drain may park several).
    const parked = [att.request, ...(att.alsoParked ?? [])].filter((r): r is StoredApprovalRequest => !!r)
    const what = parked.length ? parked.map(r => `${r.tool} — ${r.logSummary ?? r.command}`).join('; ') : att.text
    const several = parked.length > 1
    const runId = await enqueueSegment(row, {
      text: several
        ? `The agent worker restarted while these were waiting for approval (${what}). None of those actions ran and their approval requests are gone. If they are still needed, make the calls again — Tony will be asked to approve them again.`
        : `The agent worker restarted while this was waiting for Tony's approval (${what}). That action did NOT run and its approval request is gone. If it is still needed, make the call again — Tony will be asked to approve it again.`,
      eventOrigin: 'segment:approval-lost'
    })
    if (runId) n++
  }
  if (n) await kick()
  return n
}

/**
 * The "still waiting" nudge (review M1): a workstream in attention is re-announced through the usual
 * channels (origin note; a text when Tony is away NOW) at most once per NUDGE_EVERY_MS — so a wait
 * that began while he was at the keyboard still reaches his phone once he has left — and at most
 * MAX_NUDGES times per attention episode (a new question/card starts a new episode). A paused
 * workstream is never nudged (state 'paused', not 'attention'). (final review I3)
 */
export async function nudgeWaitingWorkstreams(opts: { onlyConversations?: string[]; now?: number } = {}): Promise<number> {
  if (opts.onlyConversations && !opts.onlyConversations.length) return 0
  const now = opts.now ?? Date.now()
  const rows = await useDb().select().from(workstreams).where(and(
    eq(workstreams.state, 'attention'),
    opts.onlyConversations ? inArray(workstreams.conversationId, opts.onlyConversations) : undefined
  ))
  let n = 0
  // Cycle 83 final fix wave (M4): children are nudged per TREE — one note/text listing everything a
  // coordinator's children wait on Tony for (an unescalated question waits on the coordinator, not him).
  const c = await coordinator()
  n += await c.nudgeTrees(rows.filter(r => r.isChild), { now, everyMs: NUDGE_EVERY_MS, max: MAX_NUDGES })
  // …and what a throttled moment held back of a tree's away text goes out once it may.
  await c.sweepTreeAway({ onlyConversations: opts.onlyConversations, now })
  for (const ws of rows) {
    const att = attentionOf(ws)
    if (ws.isChild) continue
    if (!att || att.kind === 'paused' || (att.nudges ?? 0) >= MAX_NUDGES || now - (att.notifiedAt ?? 0) < NUDGE_EVERY_MS) continue
    const row = await patchWorkstream(ws.id, { attention: { ...att, notifiedAt: now, nudges: (att.nudges ?? 0) + 1 } }, ['attention'])
    if (!row) continue
    const who = await tonyFacing(row)
    const tag = att.kind === 'question' ? (att.tag ?? await tagQuestion(row.id)) : null
    await notifyTony(who, `⚙ Still waiting on you — ${who.goal}\n\n${att.text}${att.kind === 'question' ? `\n\n${replyHint(tag)}` : ''}`)
    n++
  }
  return n
}

/**
 * Net under everything above (boot + every production tick): a workstream that should be moving
 * (queued/running) but has no queued-or-running segment — the process died between a segment's
 * finishRun and its successor's insert — gets its next segment. `onlyConversations` is the test seam.
 */
export async function sweepStalledWorkstreams(opts: { onlyConversations?: string[]; graceMs?: number } = {}): Promise<number> {
  if (opts.onlyConversations && !opts.onlyConversations.length) return 0
  const graceSec = Math.round((opts.graceMs ?? 30_000) / 1000)
  const scope = opts.onlyConversations
    ? sql`and w.conversation_id in (${sql.join(opts.onlyConversations.map(id => sql`${id}::uuid`), sql`, `)})`
    : sql``
  const res = await useDb().execute(sql`
    select w.id from workstreams w
    where w.state in ('queued', 'running') and not w.cancel_requested
      and w.updated_at < now() - make_interval(secs => ${graceSec})
      and not exists (select 1 from agent_runs r where r.conversation_id = w.conversation_id
                      and r.kind = 'workstream' and r.status in ('queued', 'running'))
      ${scope}`)
  let n = 0
  for (const { id } of res.rows as Array<{ id: string }>) {
    // A segment still being wrapped up in this process will queue its own successor.
    const ws = await getWorkstream(id)
    if (!ws || [...active.values(), ...ended.values()].some(s => s.workstreamId === id)) continue
    const runId = ws.failureReason ? await enqueueWhy(ws, 'budget', ws.failureReason) : await enqueueWhy(ws, 'restarted')
    if (runId) n++
  }
  return n
}

// ── Controls (the worker's `workstream-control` command; Task 6 UI) ───────────────────────────

export type WorkstreamControl = { workstreamId: string; action: 'cancel' | 'resume' | 'steer'; text?: string }

export async function controlWorkstream(p: WorkstreamControl): Promise<WorkstreamDTO> {
  let ws = await getWorkstream(p.workstreamId)
  if (!ws) throw new Error('no such workstream')
  if (p.action === 'cancel') await cancelWorkstream(ws)
  else if (p.action === 'steer') {
    const text = p.text?.trim()
    if (!text) throw new Error('steer needs text')
    if (!(await replyToWorkstream(ws, { text, modality: 'text' }))) throw new Error(`the workstream is ${ws.state}`)
  } else {
    await resumeWorkstream(ws, p.text?.trim())
  }
  await kick()
  ws = await getWorkstream(p.workstreamId)
  return workstreamDTO(ws!)
}

/** Cancel (spec §5.5): a running segment stops after its current step (a card it is parked on is
 *  denied, so that step ends); a queued segment is dropped; with nothing running it is immediate. */
export async function cancelWorkstream(ws: WorkstreamRow): Promise<void> {
  if (isTerminal(ws.state)) return
  await patchWorkstream(ws.id, { cancelRequested: true })
  const seg = [...active.values()].find(s => s.workstreamId === ws.id)
  if (seg) {
    seg.stop ??= 'cancel'
    // C3: withdrawn by the cancel, not denied by Tony (recorded cancelled / system).
    for (const requestId of pendingBusApprovals(seg.runId)) cancelBusApproval(requestId)
    return
  }
  await useDb().update(agentRuns).set({ status: 'aborted', finishedAt: sql`now()`, error: 'workstream cancelled' })
    .where(and(eq(agentRuns.conversationId, ws.conversationId), eq(agentRuns.kind, 'workstream'), eq(agentRuns.status, 'queued')))
  const [running] = await useDb().select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.conversationId, ws.conversationId), eq(agentRuns.kind, 'workstream'), eq(agentRuns.status, 'running'))).limit(1)
  // A segment 'running' in no process here (an orphan): recovery sees cancel_requested and cancels.
  if (!running) await cancelNow(ws)
}

/** Resume: a failed/cancelled workstream starts again (a used-up budget is extended by one
 *  segment's worth of steps and 30 min, so it can actually move); an attention or paused one
 *  continues without an answer (or with `text` as the answer); a stalled one gets its next segment.
 *  Cycle 83: a CHILD comes back only while its coordinator runs, and its budget is re-reserved out
 *  of the coordinator's tree (coordinator.ts reserveForResume, under the tree lock). */
export async function resumeWorkstream(ws: WorkstreamRow, text?: string): Promise<void> {
  if (ws.state === 'done') throw new Error('the workstream is already done')
  if (ws.state === 'failed' || ws.state === 'cancelled') {
    const used = usedOf(ws)
    const b = budgetOf(ws)
    // Extended within the same bounds a start is held to (review M4).
    const budget = exhausted(ws)
      ? clampBudget(resumeBudget(b, used))
      : b
    const row = await useDb().transaction(async (tx) => {
      if (ws.isChild) await (await coordinator()).reserveForResume(tx, ws, budget)
      const [r] = await tx.update(workstreams).set({
        state: 'running', cancelRequested: false, failures: 0, failureReason: null, lastOutcome: null,
        finishedAt: null, attention: null, summary: null, budget, updatedAt: sql`now()`
      }).where(and(eq(workstreams.id, ws.id), inArray(workstreams.state, ['failed', 'cancelled']))).returning()
      return r ?? null
    })
    if (!row) return
    publishWorkstream(row.id)
    ws = row
  }
  if (text) { await replyToWorkstream(ws, { text, modality: 'text' }); return }
  await releaseParked(ws)
  const row = await patchWorkstream(ws.id, { state: 'running', attention: null }, RUNNABLE)
  if (row) await enqueueWhy(row, 'continue')
}

// ── Answers by iMessage (review I3, controller ruling; cycle 83 final fix wave I2) ─────────────

/** A question Tony's iMessage can answer: state 'attention' AND kind 'question' (a paused workstream or
 *  an approval card never captures one). Cycle 83: a child's question is its coordinator's to answer —
 *  Tony's text only answers it once he was asked too (escalated: the coordinator was waiting on him). */
const OPEN_QUESTION = sql`${workstreams.state} = 'attention' and ${workstreams.attention}->>'kind' = 'question'
  and (not ${workstreams.isChild} or ${workstreams.attention}->>'escalated' = 'true')`

/** Follow-up N2: a tag is never issued again within this long of its last issue. */
export const QUESTION_TAG_REUSE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Final fix wave (I2): give an open question its `#k` handle before Tony is texted about it, so a
 * reply can say which question it answers. Follow-up N2: the smallest k that no open question holds
 * AND that was not issued within QUESTION_TAG_REUSE_MS (workstream_question_tags) — so an old text's
 * tag never reaches a different question. Under one advisory lock (two questions asked at once never
 * share a k). Null when the row no longer waits on a question Tony can answer. Idempotent.
 */
export async function tagQuestion(workstreamId: string): Promise<number | null> {
  const tag = await useDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mymind:workstream-question-tags'))`)
    const [row] = await tx.select().from(workstreams).where(and(eq(workstreams.id, workstreamId), OPEN_QUESTION)).for('update')
    const att = row ? attentionOf(row) : null
    if (!row || !att) return null
    if (att.tag) return att.tag
    const taken = new Set((await tx.select({ attention: workstreams.attention }).from(workstreams).where(OPEN_QUESTION))
      .map(r => (r.attention as WorkstreamAttention | null)?.tag).filter((t): t is number => typeof t === 'number'))
    for (const r of await tx.select({ tag: workstreamQuestionTags.tag }).from(workstreamQuestionTags)
      .where(sql`${workstreamQuestionTags.issuedAt} > now() - make_interval(secs => ${QUESTION_TAG_REUSE_MS / 1000})`)) taken.add(r.tag)
    let k = 1
    while (taken.has(k)) k++
    await tx.insert(workstreamQuestionTags).values({ tag: k, workstreamId: row.id, issuedAt: sql`now()` })
      .onConflictDoUpdate({ target: workstreamQuestionTags.tag, set: { workstreamId: row.id, issuedAt: sql`now()` } })
    await tx.update(workstreams).set({ attention: { ...att, tag: k } }).where(eq(workstreams.id, row.id))
    return k
  })
  if (tag) publishWorkstream(workstreamId)
  return tag
}

/** N2: when `tag` was issued within the reuse window and its question is closed, tell Tony so. */
async function closedQuestionReply(tag: number, opts: { onlyConversations?: string[] }): Promise<boolean> {
  const [issued] = await useDb().select().from(workstreamQuestionTags)
    .where(and(eq(workstreamQuestionTags.tag, tag), sql`${workstreamQuestionTags.issuedAt} > now() - make_interval(secs => ${QUESTION_TAG_REUSE_MS / 1000})`)).limit(1)
  if (!issued) return false
  const ws = await getWorkstream(issued.workstreamId)
  // Still open (outside the caller's scope): not closed.
  if (ws && ws.state === 'attention' && attentionOf(ws)?.kind === 'question' && attentionOf(ws)?.tag === tag) return false
  if (opts.onlyConversations && (!ws || !opts.onlyConversations.includes(ws.conversationId))) return false
  const what = ws ? (await tonyFacing(ws)).goal : 'a workstream that no longer exists'
  await workstreamNotifyDeps.text(`↪ #${tag} (${what}) is already closed — your reply was not passed on to any workstream.`, ws?.originConversationId ?? ws?.conversationId ?? null)
    .catch(err => console.error('[workstreams] closed-question reply failed:', err))
  return true
}

/** `#k` at the very start of a reply (then optional punctuation): which question it answers. */
export function parseQuestionTag(text: string): { tag: number; rest: string } | null {
  const m = /^\s*#(\d{1,4})(?![\d\w])[\s:,.\-–—]*/.exec(text)
  return m ? { tag: Number(m[1]), rest: text.slice(m[0].length) } : null
}

/**
 * An inbound iMessage while a workstream waits on a question is that question's answer: it goes into
 * the workstream (its next segment's prompt, origin `imessage:<chat>` kept) and main gets a short
 * event note naming it. Final fix wave (I2) — with several waiting, a reply starting with `#k` answers
 * the question tagged k (the tag is stripped); an untagged one answers the MOST RECENTLY NOTIFIED
 * question, and Tony is texted which workstream got it (and how to reach the others). A `#k` no open
 * question holds, or no question at all, returns null — the text lands in main as an ordinary turn,
 * and Bridget can pass it on with `answer_workstream`. `onlyConversations` scopes the lookup (test
 * seam: the dev DB is shared).
 */
export async function routeInboundAnswer(input: RunInput, opts: { mainConversationId?: string; onlyConversations?: string[] } = {}): Promise<{ runId: string; workstreamId: string } | null> {
  if (opts.onlyConversations && !opts.onlyConversations.length) return null
  const waiting = await useDb().select().from(workstreams).where(and(
    OPEN_QUESTION,
    opts.onlyConversations ? inArray(workstreams.conversationId, opts.onlyConversations) : undefined
  ))
  const tagged = parseQuestionTag(input.text)
  const hit = tagged ? waiting.find(w => attentionOf(w)?.tag === tagged.tag) : undefined
  // Follow-up N2: a tag issued within the reuse window whose question is no longer open — Tony is
  // replying to an old text. Never rerouted to anything else: he is told it is closed, and the text
  // lands in main as an ordinary turn (his words are kept).
  if (tagged && !hit && await closedQuestionReply(tagged.tag, opts)) return null
  if (!waiting.length) return null
  let ws: WorkstreamRow | undefined
  let text = input.text
  if (tagged) {
    if (hit && tagged.rest.trim()) { ws = hit; text = tagged.rest }
    else if (waiting.length > 1) return null // a #k no open question holds: not a guess between several
  }
  ws ??= [...waiting].sort((a, b) => (attentionOf(b)?.notifiedAt ?? 0) - (attentionOf(a)?.notifiedAt ?? 0))[0]!
  const r = await replyToWorkstream(ws, { ...input, text })
  if (!r) return null
  const who = await tonyFacing(ws)
  const { getOrCreateMain } = await import('../runtime/sessions')
  const { appendEvent } = await import('../../../services/conversations')
  const main = opts.mainConversationId ?? await getOrCreateMain()
  const said = text.length > 200 ? `${text.slice(0, 199)}…` : text
  await appendEvent(main, `answered ⚙ ${who.goal}: ${said}`, `workstream:${ws.id}`)
    .catch(err => console.error('[workstreams] answered note failed:', err))
  // Several were waiting: say which one this reply answered, and how to answer the rest.
  const others = waiting.filter(w => w.id !== ws.id)
  if (others.length) {
    const tagOf = (w: WorkstreamRow) => attentionOf(w)?.tag
    const rest = await Promise.all(others.map(async w => `${tagOf(w) ? `#${tagOf(w)} ` : ''}${(await tonyFacing(w)).goal}`))
    const note = `↪ Your reply answered ${tagOf(ws) ? `#${tagOf(ws)} ` : ''}${who.goal}.\nStill waiting on you: ${rest.join('; ')} — start a reply with its #number to answer it.`
    await workstreamNotifyDeps.text(note, ws.originConversationId ?? ws.conversationId)
      .catch(err => console.error('[workstreams] answer confirmation failed:', err))
  }
  return { runId: r.runId, workstreamId: ws.id }
}
