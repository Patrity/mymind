// Cycle 81 (spec §5.2–5.4): the workstream state machine.
//
// A workstream advances in SEGMENTS: each is one agent_runs row (kind='workstream', profile
// 'interactive', no socket) on the workstream's own thread, executed by the ordinary queue/runner
// with up to SEGMENT_MAX_STEPS model steps over the thread's persisted history. When a segment ends,
// `onSegmentFinished` (queue.ts execute, after finishRun) decides what happens next:
//   finish_workstream called → done (the tool already posted the summary + notified);
//   ask_tony called          → attention {question}; the next segment starts on Tony's reply;
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
import { agentRuns, channelApprovals, conversationMessages, conversations, workstreams, type AgentRun } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import { createRun } from '../runtime/runs'
import { abortRun } from '../runtime/aborts'
import { drainSteerFor, pushSteer } from '../runtime/inbox'
import { busApprovalChannel, decideBusApproval, pendingBusApprovals } from '../runtime/bus-approvals'
import { createRunEventWriter, type HubFrame, type RunEventWriter } from '../../bus/events'
import { APPROVAL_WITHDRAWN } from '../../channels/approvals'
import { parseToolsetIds } from '../toolsets'
import type { ApprovalRequest } from '../types'
import type { StepUsage } from '../run'
import type { WorkstreamPromptInfo } from '../prompt'
import type { RunInput, RunOutcome } from '../runtime/types'
import {
  BUDGET_LIMITS, DEFAULT_WORKSTREAM_BUDGET, TERMINAL_WORKSTREAM_STATES, ZERO_USED, type StoredApprovalRequest, type WorkstreamAttention,
  type WorkstreamBudget, type WorkstreamDTO, type WorkstreamUsed
} from '../../../shared/types/workstreams'
import {
  budgetOf, exhausted, getWorkstream, patchWorkstream, publishWorkstream, toWorkstreamDTO, usedOf,
  workstreamForConversation, type WorkstreamRow
} from './store'
import { promptInfo, segmentOrigin, segmentText, type SegmentWhy } from './prompt'
import { noteOrigin, notifyTony, workstreamNotifyDeps } from './notify'
import { stepCostUsd } from './cost'

/** Non-terminal workstreams at once (review I2, controller ruling): bounds fan-out through jobs/wakes. */
export const MAX_ACTIVE_WORKSTREAMS = 3
export class WorkstreamCapError extends Error { override name = 'WorkstreamCapError' }
/** A workstream still waiting on Tony is re-announced at most this often (review M1). */
export const NUDGE_EVERY_MS = 2 * 60 * 60 * 1000
/** Two consecutive segments with no tool call and no finish_workstream → ask Tony (review M3). */

/** Model steps per segment (spec §5.2). */
export const SEGMENT_MAX_STEPS = 40
/** Consecutive failed segments that end the workstream. */
export const MAX_CONSECUTIVE_FAILURES = 3
/** A segment that overruns its remaining wall budget by this much (a step that never ends) is aborted. */
export const WALL_HARD_GRACE_MS = 60_000
/** The final summary step's own hard cap. */
export const FINAL_STEP_MAX_MS = 10 * 60_000

type Channel = (req: ApprovalRequest) => Promise<{ approved: boolean }>
type StopReason = 'finished' | 'attention' | 'cancel' | 'budget' | 'yield' | 'park'
const RUNNABLE: Array<WorkstreamRow['state']> = ['queued', 'running', 'attention']

function isTerminal(state: WorkstreamRow['state']): boolean { return TERMINAL_WORKSTREAM_STATES.includes(state) }

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.code === '23505' || e?.cause?.code === '23505'
}

async function kick(): Promise<void> {
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
    state: 'running', currentRunId: run.id, attention: null,
    ...(final && !ws.failureReason ? { failureReason: final } : {})
  }, RUNNABLE)
  if (!patched) return skipped()
  ws = patched
  final = ws.failureReason
  const seg = makeSegment(run, ws, { skip: false, final: !!final })
  active.set(run.id, seg)
  return seg
}

function makeSegment(run: AgentRun, ws: WorkstreamRow, o: { skip: boolean; final: boolean }): Segment {
  const base = usedOf(ws)
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
  let mirror: RunEventWriter | null = null
  let done = false
  let parking = false
  // model in this segment, is approved without asking twice — once.

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
    }).catch(err => console.error('[workstreams] checkpoint failed:', err))
    return chain
  }

  const seg: Segment = {
    runId: run.id,
    workstreamId: ws.id,
    skip: o.skip,
    final: o.final,
    maxSteps: o.final ? 1 : Math.max(1, Math.min(SEGMENT_MAX_STEPS, budget.maxSteps - base.steps)),
    promptInfo: promptInfo(ws, o.final ? ws.failureReason : null),
    stop: null,
    toolCalls: 0,
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
      let current: ApprovalRequest | null = null
      const bus = busApprovalChannel(run.id, {
        signal,
        timeoutMs: null, // spec §3.4/§5.4: a workstream approval waits until decided (or the run stops)
        publish: (f) => {
          publish(f)
          // The card shows in the chat it was started from too (spec §5.4): the same frames, on the
          // origin conversation's log under this run's id — so the web's card tracking, re-send on
          // attach (openApprovalFrames: a still-running run) and decision forwarding all just work.
          if ((f.type === 'approval' || f.type === 'approval-resolved') && ws.originConversationId) {
            mirror ??= createRunEventWriter(run.id, ws.originConversationId)
            mirror.emit(f)
          }
        },
        onWaiting: (requestId, isWaiting) => {
          if (isWaiting) {
            const req = current
            const race = new AbortController()
            waiting.set(requestId, race)
            pause()
            void checkpoint()
            const text = req ? approvalText(req) : 'An action needs your approval.'
            // The request itself is kept on the row (review I1): a drain or crash can restore the card.
            const attention: ParkedAttention = { kind: 'approval', text, requestId, runId: run.id, notifiedAt: Date.now(), ...(req ? { request: storedRequest(req) } : {}) }
            void serial(async () => {
              const row = await patchWorkstream(ws.id, { state: 'attention', attention }, ['running', 'attention'])
              // The chat it came from hears about it too (review M1), not only the card.
              if (row) await noteOrigin(row, `⚙ Workstream waiting for your approval — ${row.goal}\n${text}`)
            })
            // Away: the iMessage prompt too. Whichever answers first decides; the other is withdrawn.
            if (req) void startAwayApproval(run.id, requestId, req, race.signal)
          } else {
            waiting.get(requestId)?.abort(APPROVAL_WITHDRAWN)
            waiting.delete(requestId)
            // Parking (drain): the card is being kept for the next worker — leave attention as it is.
            if (!waiting.size && !parking) {
              resume()
              void serial(() => patchWorkstream(ws.id, { state: 'running', attention: null }, ['attention']))
            }
          }
        }
      })
      return (req) => {
        current = req
        return bus(req)
      }
    },
    park() {
      if (!waiting.size || done) return false
      parking = true
      seg.stop = 'park'
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

async function startAwayApproval(runId: string, requestId: string, req: ApprovalRequest, signal: AbortSignal): Promise<void> {
  try {
    if (!(await workstreamNotifyDeps.isAway()) || signal.aborted) return
    const r = await workstreamNotifyDeps.imessageApproval(runId, req, signal)
    // Withdrawn because the card decided first: nothing to do (decideBusApproval would be a no-op).
    if (!r || signal.aborted) return
    decideBusApproval({ requestId, approved: r.approved })
  } catch (err) {
    console.error('[workstreams] iMessage approval failed:', err)
  }
}

// ── Starting, continuing, finishing ──────────────────────────────────────────────────────────

/** Queue the next segment. Null when one is already queued or running (the unique index): a
 *  continuation is then redundant, and Tony's words are folded into the queued one. */
async function enqueueSegment(ws: WorkstreamRow, input: { text: string; eventOrigin?: string; attachments?: RunInput['attachments']; origin?: string }): Promise<string | null> {
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
      kind: 'workstream', input: runInput
    })
    await patchWorkstream(ws.id, { currentRunId: run.id })
    return run.id
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    if (!input.eventOrigin) await foldIntoQueued(ws, input.text)
    return null
  }
}

async function enqueueWhy(ws: WorkstreamRow, why: SegmentWhy, detail?: string): Promise<string | null> {
  return enqueueSegment(ws, { text: segmentText(why, ws, detail), eventOrigin: segmentOrigin(why) })
}

/** Tony's words into the segment that is queued and not yet claimed: they replace a system
 *  continuation prompt (his message is the better next prompt) or are appended to his earlier one. */
async function foldIntoQueued(ws: WorkstreamRow, text: string): Promise<string | null> {
  const res = await useDb().execute(sql`
    update agent_runs set input = case
        when input ? 'eventOrigin' then (input - 'eventOrigin') || jsonb_build_object('text', ${text}::text)
        else jsonb_set(input, '{text}', to_jsonb((input->>'text') || E'\n\n' || ${text}::text))
      end
    where conversation_id = ${ws.conversationId}::uuid and kind = 'workstream' and status = 'queued'
    returning id`)
  return (res.rows[0] as { id?: string } | undefined)?.id ?? null
}

/**
 * Start a workstream: its own thread (`⚙ <goal>`), the row, and the first segment. Used by the
 * `start_workstream` tool (Bridget) and the UI (Task 6).
 */
export async function startWorkstream(i: {
  goal: string; toolsets?: string[]; budget?: Partial<WorkstreamBudget>; originConversationId?: string | null
}, deps: { kick?: boolean; /** test seam (the dev DB is shared) */ cap?: number } = {}): Promise<WorkstreamDTO> {
  const goal = i.goal.trim()
  if (!goal) throw new Error('a workstream needs a goal')
  const oneLine = goal.replace(/\s+/g, ' ')
  const cap = deps.cap ?? MAX_ACTIVE_WORKSTREAMS
  // The cap (review I2, controller ruling): count and insert under one advisory lock, so two starts
  // racing (jobs/wakes firing together) can't both slip under it.
  const ws = await useDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mymind:workstreams:start'))`)
    const open = await tx.select({ goal: workstreams.goal }).from(workstreams).where(inArray(workstreams.state, RUNNABLE))
    if (open.length >= cap) {
      throw new WorkstreamCapError(`There are already ${open.length} workstreams in progress (the limit is ${cap}): ${open.map(o => `"${o.goal.length > 60 ? `${o.goal.slice(0, 59)}…` : o.goal}"`).join(', ')}. Tell Tony — one has to finish or be cancelled before another can start.`)
    }
    const [conv] = await tx.insert(conversations).values({ title: `⚙ ${oneLine.length <= 70 ? oneLine : `${oneLine.slice(0, 69).trimEnd()}…`}` }).returning({ id: conversations.id })
    const [row] = await tx.insert(workstreams).values({
      conversationId: conv!.id, originConversationId: i.originConversationId ?? null, goal, state: 'queued', used: ZERO_USED,
      toolsets: parseToolsetIds(i.toolsets ?? []), budget: clampBudget(i.budget)
    }).returning()
    return row!
  })
  publishChange({ resource: 'conversation', action: 'created', id: ws.conversationId })
  publishWorkstream(ws.id, 'created')
  await enqueueWhy(ws, 'start')
  if (deps.kick !== false) await kick()
  return toWorkstreamDTO((await getWorkstream(ws.id)) ?? ws)
}

/** What a message typed into a workstream's thread does (spec §5.4): while a segment runs it is a
 *  steer; while queued it joins the queued segment; in attention (or stalled) it starts the next
 *  segment. Null for a finished workstream — the caller treats it as an ordinary chat turn. */
export async function replyToWorkstream(ws: WorkstreamRow, input: RunInput): Promise<{ runId: string; steered: boolean } | null> {
  if (isTerminal(ws.state)) return null
  const plain = !input.attachments?.length && !input.skill
  for (let attempt = 0; attempt < 3; attempt++) {
    const [seg] = await useDb().select({ id: agentRuns.id, status: agentRuns.status }).from(agentRuns)
      .where(and(eq(agentRuns.conversationId, ws.conversationId), eq(agentRuns.kind, 'workstream'), inArray(agentRuns.status, ['queued', 'running'])))
      .limit(1)
    if (seg?.status === 'running' && plain) {
      if (await pushSteer(seg.id, ws.conversationId, input.text, 'user')) return { runId: seg.id, steered: true }
      continue // it just finished: look again
    }
    if (seg?.status === 'queued' && plain) {
      const id = await foldIntoQueued(ws, input.text)
      if (id) return { runId: id, steered: false }
      continue // claimed meanwhile: steer instead
    }
    // No segment (attention, stalled), or attachments/skill that can't ride a steer: its own segment
    // (with one already there, enqueueSegment folds the text into a queued one instead).
    const runId = await enqueueSegment(ws, { text: input.text, ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(input.origin ? { origin: input.origin } : {}) })
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
  if (row) await notifyTony(row, `⚙ Workstream stopped — ${ws.goal}\nReason: ${reason}${summary ? `\n\n${summary}` : ''}`)
}

async function cancelNow(ws: WorkstreamRow, lastOutcome?: string): Promise<void> {
  await releaseParked(ws)
  await patchWorkstream(ws.id, { state: 'cancelled', attention: null, finishedAt: new Date(), ...(lastOutcome ? { lastOutcome } : {}) }, RUNNABLE)
}

function attentionOf(ws: Pick<WorkstreamRow, 'attention'>): WorkstreamAttention | null {
  return (ws.attention as WorkstreamAttention | null) ?? null
}

/** Ask Tony: attention {question} + the usual notification ("reply to answer"). */
async function askTony(ws: WorkstreamRow, question: string, lastOutcome?: string): Promise<void> {
  const row = await patchWorkstream(ws.id, {
    state: 'attention', attention: { kind: 'question', text: question, notifiedAt: Date.now() }, ...(lastOutcome ? { lastOutcome } : {})
  }, ['running', 'attention'])
  if (row) await notifyTony(row, questionNote(row.goal, question))
}

export function questionNote(goal: string, question: string): string {
  return `⚙ Workstream needs you — ${goal}\n\n${question}\n\nReply to answer.`
}

/** After a segment's run has finished (queue.ts execute, after finishRun committed). Returns the
 *  next segment's run id, if one was queued (the caller's re-pump claims it). */
export async function onSegmentFinished(run: AgentRun, outcome: RunOutcome): Promise<string | null> {
  const seg = ended.get(run.id) ?? active.get(run.id)
  if (seg) await seg.end()
  ended.delete(run.id)
  const ws = await workstreamForConversation(run.conversationId)
  if (!ws || isTerminal(ws.state) || seg?.skip) {
    if (ws && seg?.skip && ws.cancelRequested) await cancelNow(ws)
    return null
  }
  const stop = seg?.stop ?? null
  if (ws.cancelRequested || stop === 'cancel') { await cancelNow(ws, outcome.status); return null }

  // Drained while parked on a card (review I1): the request stays on the row; the next worker
  // restores the card. Not a failure, not an interruption.
  if (stop === 'park') { await patchWorkstream(ws.id, { lastOutcome: 'parked' }); return null }

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
    const unread = await drainSteerFor(run.id)
    await patchWorkstream(ws.id, { lastOutcome: outcome.status, failures: 0 })
    if (!unread.length) return null
    const next = await enqueueSegment(current, { text: unread.join('\n\n') })
    if (next) await patchWorkstream(ws.id, { state: 'running', attention: null }, RUNNABLE)
    return next
  }

  if (outcome.status === 'failed') return countFailure(current, run, outcome.error ?? 'unknown error')

  if (outcome.status === 'aborted') {
    // Not cancel, not budget, not a drain: Tony pressed Stop in the thread. Pause, don't lose it.
    const unread = await drainSteerFor(run.id)
    if (unread.length) {
      await patchWorkstream(ws.id, { lastOutcome: 'aborted' })
      return enqueueSegment(current, { text: unread.join('\n\n') })
    }
    await patchWorkstream(ws.id, { state: 'attention', lastOutcome: 'aborted', attention: { kind: 'question', text: 'Stopped. Reply in this thread to continue, or cancel it.', notifiedAt: Date.now() } }, ['running'])
    return null
  }

  // Idle segments (review M3): no tool call and no finish_workstream. The first gets a nudge prompt;
  // a second in a row means the model believes it is done (or is stuck) — ask Tony instead of
  // burning the budget on empty segments.
  const idle = stop !== 'yield' && (seg?.toolCalls ?? 1) === 0
  if (idle && current.lastOutcome === 'idle') {
    const unread = await drainSteerFor(run.id)
    if (unread.length) return enqueueSegment(current, { text: unread.join('\n\n') })
    await askTony(current, 'The last two segments made no progress (no tool calls, no finish). Is this done? Reply with what to do next, or cancel it.', 'idle')
    return null
  }
  await patchWorkstream(ws.id, { failures: 0, lastOutcome: idle ? 'idle' : 'done' })
  return continueWith(current, run, stop === 'yield' ? 'restarted' : idle ? 'idle' : 'continue')
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
  const unread = await drainSteerFor(run.id)
  if (unread.length) return enqueueSegment(ws, { text: unread.join('\n\n') })
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
  await expireOrphanPrompts(run.id).catch(err => console.error('[workstreams] expiring orphaned prompts failed:', err))
  const ws = await workstreamForConversation(run.conversationId)
  if (!ws || isTerminal(ws.state)) return null
  if (ws.cancelRequested) { await cancelNow(ws, 'interrupted'); return null }
  const att = attentionOf(ws)
  const waitingOnTony = ws.state === 'attention' && (att?.kind === 'question' || (att?.kind === 'approval' && !!att.request))
  if (waitingOnTony) {
    // Words he sent to the dead segment are his answer (review M7).
    const unread = await drainSteerFor(run.id)
    if (!unread.length) {
      await patchWorkstream(ws.id, { lastOutcome: att?.kind === 'approval' ? 'parked' : 'interrupted' })
      return null
    }
    await releaseParked(ws)
    const next = await enqueueSegment(ws, { text: unread.join('\n\n') })
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
  for (const cid of [ws.conversationId, ws.originConversationId]) {
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
    const what = att.request ? `${att.request.tool} — ${att.request.logSummary ?? att.request.command}` : att.text
    const runId = await enqueueSegment(row, {
      text: `The agent worker restarted while this was waiting for Tony's approval (${what}). That action did NOT run and its approval request is gone. If it is still needed, make the call again — Tony will be asked to approve it again.`,
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
 * that began while he was at the keyboard still reaches his phone once he has left.
 */
export async function nudgeWaitingWorkstreams(opts: { onlyConversations?: string[]; now?: number } = {}): Promise<number> {
  if (opts.onlyConversations && !opts.onlyConversations.length) return 0
  const now = opts.now ?? Date.now()
  const rows = await useDb().select().from(workstreams).where(and(
    eq(workstreams.state, 'attention'),
    opts.onlyConversations ? inArray(workstreams.conversationId, opts.onlyConversations) : undefined
  ))
  let n = 0
  for (const ws of rows) {
    const att = attentionOf(ws)
    if (!att || now - (att.notifiedAt ?? 0) < NUDGE_EVERY_MS) continue
    const row = await patchWorkstream(ws.id, { attention: { ...att, notifiedAt: now } }, ['attention'])
    if (!row) continue
    await notifyTony(row, `⚙ Still waiting on you — ${row.goal}\n\n${att.text}${att.kind === 'question' ? '\n\nReply to answer.' : ''}`)
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
  return toWorkstreamDTO(ws!)
}

/** Cancel (spec §5.5): a running segment stops after its current step (a card it is parked on is
 *  denied, so that step ends); a queued segment is dropped; with nothing running it is immediate. */
export async function cancelWorkstream(ws: WorkstreamRow): Promise<void> {
  if (isTerminal(ws.state)) return
  await patchWorkstream(ws.id, { cancelRequested: true })
  const seg = [...active.values()].find(s => s.workstreamId === ws.id)
  if (seg) {
    seg.stop ??= 'cancel'
    for (const requestId of pendingBusApprovals(seg.runId)) decideBusApproval({ requestId, approved: false })
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
 *  segment's worth of steps and 30 min, so it can actually move); an attention one continues
 *  without an answer (or with `text` as the answer); a stalled one gets its next segment. */
export async function resumeWorkstream(ws: WorkstreamRow, text?: string, opts: { /** test seam */ cap?: number } = {}): Promise<void> {
  if (ws.state === 'done') throw new Error('the workstream is already done')
  if (ws.state === 'failed' || ws.state === 'cancelled') {
    const used = usedOf(ws)
    const b = budgetOf(ws)
    // Extended within the same bounds a start is held to (review M4).
    const budget = exhausted(ws)
      ? clampBudget({ maxSteps: Math.max(b.maxSteps, used.steps + SEGMENT_MAX_STEPS), maxWallMs: Math.max(b.maxWallMs, used.wallMs + 30 * 60_000) })
      : b
    // Reactivating counts against the cap like a start (fix round 2), under the same lock.
    const row = await useDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mymind:workstreams:start'))`)
      const open = await tx.select({ id: workstreams.id }).from(workstreams).where(inArray(workstreams.state, RUNNABLE))
      if (open.length >= (opts.cap ?? MAX_ACTIVE_WORKSTREAMS)) {
        throw new WorkstreamCapError(`There are already ${open.length} workstreams in progress (the limit is ${opts.cap ?? MAX_ACTIVE_WORKSTREAMS}) — finish or cancel one before resuming this one.`)
      }
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

// ── Answers by iMessage (review I3, controller ruling) ──────────────────────────────────────────

/**
 * An inbound iMessage while EXACTLY ONE workstream waits on a question is that question's answer:
 * it goes into the workstream (its next segment's prompt, origin `imessage:<chat>` kept) and main
 * gets a short event note. With none or several waiting it returns null — the text lands in main as
 * an ordinary turn, and Bridget can pass it on with `answer_workstream`. `onlyConversations` scopes
 * the lookup (test seam: the dev DB is shared).
 */
export async function routeInboundAnswer(input: RunInput, opts: { mainConversationId?: string; onlyConversations?: string[] } = {}): Promise<{ runId: string; workstreamId: string } | null> {
  if (opts.onlyConversations && !opts.onlyConversations.length) return null
  const waiting = await useDb().select().from(workstreams).where(and(
    eq(workstreams.state, 'attention'), sql`${workstreams.attention}->>'kind' = 'question'`,
    opts.onlyConversations ? inArray(workstreams.conversationId, opts.onlyConversations) : undefined
  )).limit(2)
  if (waiting.length !== 1) return null
  const ws = waiting[0]!
  const r = await replyToWorkstream(ws, input)
  if (!r) return null
  const { getOrCreateMain } = await import('../runtime/sessions')
  const { appendEvent } = await import('../../../services/conversations')
  const main = opts.mainConversationId ?? await getOrCreateMain()
  const said = input.text.length > 200 ? `${input.text.slice(0, 199)}…` : input.text
  await appendEvent(main, `answered ⚙ ${ws.goal}: ${said}`, `workstream:${ws.id}`)
    .catch(err => console.error('[workstreams] answered note failed:', err))
  return { runId: r.runId, workstreamId: ws.id }
}
