// server/lib/agent/runtime/runner.ts
// ONE turn, server-owned. This is ws.ts's turn body moved (not rewritten): the ordering rules
// in the comments below — persist before the `conversation` frame, rescue on throw/abort,
// capture the leaf before the first await — were each learned from a production bug.
import { eq, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { conversations, conversationMessages, type AgentRun } from '../../../db/schema'
import { handleTurn, type TurnDeps, type VoiceEvent } from '../../voice/orchestrator'
import { createTurnStream } from '../../voice/turn-stream'
import { buildTurnPersistPayload } from '../../voice/turn-persist'
import { partialTurnMessages } from '../../voice/turn-partial'
import { appendMessages, getAgentHistory, captureTurnLeaf, type NewConvMessage } from '../../../services/conversations'
import { publishChange } from '../../../utils/live-bus'
import { recordEvent } from '../../observability/record'
import { assembleContext } from '../assemble'
import { messageText } from '../run'
import type { AgentMessage } from '../run'
import { bridgetProfile, childWorkstreamProfile, coordinatorProfile, TAINTING_TOOL_NAMES, type AgentProfile } from '../profile'
import { listSubagentModels } from '../../ai/registry/resolve'
import { childTaintOf, injectionWarningOf, producedContent, warningTaintOf } from '../tool-history'
import { beginSegment, type Segment } from '../workstreams/loop'
import { parseToolsetIds, type ToolsetId } from '../toolsets'
import type { RunPublisher } from './stream'
import { busPublisher } from './bus-publisher'
import { registerAbort, releaseAbort } from './aborts'
import { approvalFor, hasApprovalChannel, registerApprovalChannel, registerTurnStream, releaseTurnStream, unregisterApprovalChannel } from './approvals'
import { busApprovalChannel } from './bus-approvals'
import { drainInboxFor } from './inbox'
import { headlessTools } from './gate'
import { eventModelText, wakeOrigin } from './event-text'
import { COORDINATOR_ORIGIN } from '../../../shared/types/workstreams'
import { groupTurns, costTurns, keepTrailingTurns, LIGHT_CONTEXT_TURNS, RUNTIME_CONTEXT_BUDGET } from './history'
import { isSuppressedReply } from './suppress'
import type { RunInput, RunOutcome } from './types'
import type { ApprovalSurface, RunTaint } from '../judge/types'
import { planDeliveries, queueFailureNote } from '../../channels/deliver'
import { insertDeliveries } from '../../channels/outbox'
import { channelPresence } from '../../channels/presence'
import { replyToApprovalChannel } from '../../channels/approvals'
import { unavailableGoogleToolsets } from '../../google/connections'

export interface RunnerDeps {
  runAgent?: TurnDeps['runAgent']
  assemble?: typeof assembleContext
  /** Where the run's frames go. Default: the Postgres run-event log (cycle 81) — tests pass an
   *  in-process StreamHub to capture them. */
  hub?: RunPublisher
  afterPersist?: (conversationId: string) => void
  /** Cycle 79: on-demand sets to leave out of the directory this turn (default: gmail/calendar
   *  while no Google account is connected). */
  unavailableToolsets?: () => Promise<ToolsetId[]>
}

let turnSeq = Date.now()
/** Monotonic across restarts (seeded from the clock): the client drops frames whose turnId is
 *  below the highest it has seen, so a counter that reset to 0 on deploy would silence every
 *  turn until reload. */
export function nextTurnId(): number {
  return ++turnSeq
}

// The headless gate (Task 11): every tool that edits or destroys existing data becomes a
// /review proposal instead of running, and anything `dangerous` (exec) is excluded outright —
// see gate.ts. Bound to THIS run so a proposal's review row can point back at it.
/** Cycle 84: where a run's approvals are raised — Smart Approvals applies per surface (spec §2.3):
 *  a workstream segment, a headless run (a job, a wake: never auto-approved), else chat. */
export function approvalSurface(run: Pick<AgentRun, 'profile' | 'trigger'>, isSegment: boolean): ApprovalSurface {
  if (isSegment) return 'workstream'
  return run.profile === 'headless' || run.trigger === 'wake' ? 'headless' : 'chat'
}

function headlessProfile(run: AgentRun): AgentProfile {
  return { ...bridgetProfile, id: 'headless', tools: headlessTools(bridgetProfile.tools, { id: run.id, conversationId: run.conversationId }) }
}

export async function runTurn(run: AgentRun, deps: RunnerDeps = {}): Promise<RunOutcome> {
  const conversationId = run.conversationId
  const hub = deps.hub ?? busPublisher(run.id, conversationId)
  const input = run.input as RunInput
  const isWake = run.trigger === 'wake'
  const origin = isWake ? wakeOrigin(run.wakeReason ?? 'unspecified') : null
  // Every frame fans out to the thread's sockets. No audio here (cycle 81, spec §4): the web's
  // voice socket that originated a spoken run synthesizes it from these same text frames.
  const send = (d: string) => hub.publish(conversationId, d)
  // Reaches the model (it answers in its spoken style); a wake never speaks.
  const speak = !isWake && !!input.speak
  // What the ws.ts closure read off the connection / the frame, now read off the run.
  const inputModality = input.modality
  const speakFlag = speak
  const turnAttachments = input.attachments ?? []
  // The text the MODEL sees. A wake's persisted row is the raw prompt (role 'event'); the model
  // reads it through eventModelText, same as it will on every later turn's history.
  // Cycle 81: a workstream segment's own prompt ("continue", "restarted", …) persists as an EVENT
  // row with this origin, like a wake's — it is not something Tony said.
  const eventOrigin = !isWake && input.eventOrigin ? input.eventOrigin : null
  const userText = isWake ? eventModelText(origin, input.text) : eventOrigin ? eventModelText(eventOrigin, input.text) : input.text

  let ts: ReturnType<typeof createTurnStream> | null = null
  // Declared out here so the `finally` rescue can still see them when the turn throws.
  let reasoningText = ''
  let turnUsage: { inputTokens?: number, outputTokens?: number, totalTokens?: number, contextTokens?: number, modelDefId?: string } | null = null
  let liveUserText = ''
  let liveAssistantText = ''
  // Every steer runAgent drained this turn, in drain order. The model saw them spliced into its
  // prompt, so the transcript must carry them too (spec §4.4) — otherwise a reload, the next
  // turn's history and the summaries all lose words Tony actually sent. Out here so the rescue
  // path persists them as well. Steers never drained are NOT here: queue.ts requeueUnconsumed
  // turns those into the next run.
  // Cycle 83 fix round 2: a coordinator's child report steered in mid-turn rides here too — as an
  // EVENT row (`segment:children`), never as words Tony typed.
  const drainedSteers: Steer[] = []
  const turnStart = Date.now()
  let ttftMs: number | undefined
  // The branch this turn was actually typed into. `appendMessages` reads
  // conversations.active_leaf_id at PERSIST time, but PATCH /api/conversations/:id/leaf
  // (cycle 68) can move that column mid-turn — from another tab, or the user switching
  // branches while a reply is still streaming. Captured once, up front (the thread itself is
  // fixed: run.conversationId), so both the success and rescue appends chain from the
  // branch the user was reading, not wherever the leaf drifted to by the time this
  // persists. This only fixes CHAINING — the leaf still moves to the new reply
  // afterwards regardless (a ruled UX tradeoff, not a bug: both branches stay reachable).
  let turnLeafId: string | null | undefined
  // Built once, called at each of the two persist sites below — a single definition so
  // the rescue path can never again drift from the success path's construction (that was
  // this file's one production bug already, just in a different field). Each call takes
  // its own `Date.now()` snapshot, which is correct: the rescue path's call (if it runs)
  // happens later than the success path's, and should report how long the turn actually
  // ran up to THAT persist, not a timestamp copied in from the other branch.
  const buildUsageWithTiming = () => ({
    ...(turnUsage ?? {}),
    startedAt: new Date(turnStart).toISOString(),
    ttftMs,
    durationMs: Date.now() - turnStart
  })
  let persisted = false
  // True once the `finally` rescue's append has committed — the rescued rows are real rows.
  let rescued = false
  // True when the turn COMPLETED as a suppressed (NO_REPLY) wake: writing nothing was the
  // decision, not a failure, so the `finally` rescue must not second-guess it.
  let silent = false
  let outcome: RunOutcome = { status: 'done', suppressed: false, usage: null }
  // The turn threw (not an abort): an iMessage-origin run texts a short failure note (I3).
  let failed = false
  // Cycle 81: this run is a workstream segment (workstreams/loop.ts) — set in the try below.
  let seg: Segment | null = null
  // Registered immediately before the try whose `finally` releases them: nothing that can throw
  // may run in between, or a run would leak its controller and its hub replay buffer.
  const ac = registerAbort(run.id)
  const turnId = nextTurnId()
  hub.beginRun(conversationId)
  try {
    void channelPresence.start(run) // read receipt + typing in the reply chat; never throws
    // Live state is now assembled exactly once per turn, inside assembleContext
    // (called below) — that is the single fixed 'live' tier, budgeted
    // alongside resident memories and retrieval. Building it again here would inject
    // a second, unbudgeted copy of the same "Current context / Active projects / Open
    // tasks" block into every prompt (and pay its two indexed queries twice); see
    // orchestrator.ts's `context` construction, which concatenates this value with
    // buildMemoryContext's output.
    ts = createTurnStream({ turnId, attachments: turnAttachments, send })
    // Active while this turn runs, so requestApproval (fired from inside exec!) can emit
    // the approval-request chunk into THIS turn's stream — keyed by run id, and a conversation
    // runs one run at a time (agent_runs_one_running), so the stream found is always this turn's.
    registerTurnStream(run.id, ts)
    // A run a web socket originated asks on the card (cycle 81, spec §3.4): the request goes out on
    // this run's frame stream and the web answers with an `approval-decision` command — 120s
    // auto-deny, denied at once on abort. Any other interactive run prompts over iMessage when its
    // reply_to (read at request time) names a chat; otherwise it denies, as before.
    // A workstream segment (cycle 81, spec §5.4): no socket, yet interactive — its approvals wait on
    // the card with NO timeout (attention {approval}), shown in the workstream thread, mirrored into
    // the chat it was started from, and raced with an iMessage prompt while Tony is away.
    if (run.kind === 'workstream') {
      seg = await beginSegment(run)
      if (seg.skip) {
        // Cancelled (or finished) while this segment sat queued: nothing to run, nothing to persist.
        silent = true
        outcome = { status: 'aborted' }
        return outcome
      }
      registerApprovalChannel(run.id, seg.approvalChannel({ publish: f => send(JSON.stringify(f)), signal: ac.signal }))
    }
    if (run.profile === 'interactive' && !hasApprovalChannel(run.id)) {
      registerApprovalChannel(run.id, run.originSinkId
        ? busApprovalChannel(run.id, { signal: ac.signal, publish: f => send(JSON.stringify(f)) })
        : replyToApprovalChannel(run.id, { signal: ac.signal }))
    }
    const emit = (e: VoiceEvent) => {
      if (e.type === 'transcript') {
        if (e.role === 'user') liveUserText = e.text
        else {
          // First assistant token: the wait before this is model latency, not generation.
          if (ttftMs === undefined) ttftMs = Date.now() - turnStart
          liveAssistantText += e.text
        }
      }
      // Idle-segment detection (workstreams/loop.ts, review M3) counts completed tool calls.
      if (e.type === 'tool' && seg) {
        seg.toolCalls++
        // Cycle 83: the same rule as the run-level taint (ai-tools.ts), persisted on the workstream —
        // a tainted child taints the coordinator run that reads its output. Cycle 84: so does a result
        // the output guard flagged.
        // Final fix wave (C1): runAgent's onTaint below is the primary path; this backstop covers a
        // mail read only. Follow-up (N1/N2): `workspace` is never persisted (derived live) and a guard
        // flag is persisted by onTaint only when it is a REAL verdict (`flagged`, not `unverified`).
        if (TAINTING_TOOL_NAMES.has(e.name) && producedContent(e.result)) seg.markTainted(['mail'])
        // A tainted child's persisted sources (a coordinator reading it), and a REAL guard verdict
        // (a fail-closed warning reads `unverified` — run-only, never persisted).
        const fromChild = childTaintOf(e.result)
        if (fromChild.length) seg.markTainted(fromChild)
        if (warningTaintOf(injectionWarningOf(e.result) ?? '') === 'flagged') seg.markTainted(['flagged'])
      }
      if (e.type === 'reasoning') reasoningText += e.text
      // Overwrite, not accumulate: at most one usage event per turn in the common
      // case, and if the rare forced-final recovery path (run.ts) yields a second
      // one, it's from the streamText call that actually produced the visible text —
      // that supersedes the aborted first call's usage rather than adding to it.
      else if (e.type === 'usage') turnUsage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens, totalTokens: e.totalTokens, contextTokens: e.contextTokens, modelDefId: e.modelDefId }
      // A wake run streams ONLY `state` frames (cycle 74 fix round 1, widening Task 7's ruling
      // that withheld its text and reasoning). Its prompt is not something Tony said, so no
      // user-message; its text/reasoning would show a suppressed NO_REPLY before the drop; and
      // any tool/usage chunk would open a live assistant message that — a silent wake sending no
      // `persisted` re-read (D4) — stays on screen as a ghost and makes the viewer's next re-read
      // refuse the shorter server list. Withheld here, not filtered client-side, so a subscriber
      // never observes one frame. What she said reaches a subscriber only via the `persisted`
      // re-read below, and a silent wake shows nothing at all. Interactive runs are untouched.
      if (isWake && e.type !== 'state') return
      // A segment's own prompt is an event row, not a bubble Tony typed: no user-message frame.
      if (eventOrigin && e.type === 'transcript' && e.role === 'user') return
      ts!.emit(e)
    }
    // The thread this turn was SENT to is run.conversationId, fixed when the run was created
    // (resolveSession made the conversation first), so nothing mid-turn can redirect a rescued
    // turn into a different thread than the one the user was typing in.
    // The branch this turn was sent into, same reasoning — read now, before the turn's
    // own await, not at persist time.
    turnLeafId = await captureTurnLeaf(conversationId)

    // Setup that the ws.ts closure did inside `exec` — inside this `try`, so a failure here
    // takes the same rescue path as a failing model (the question still persists).
    const [conv] = await useDb().select({ kind: conversations.kind, title: conversations.title, activeToolsets: conversations.activeToolsets })
      .from(conversations).where(eq(conversations.id, conversationId)).limit(1)
    const fullHistory = await getAgentHistory(conversationId)
    // A light-context run (a job's `context: light`) keeps only the last few turns — sliced here,
    // BEFORE costing, so the budget and droppedTurns below describe what the model really sees.
    const allTurns = groupTurns(fullHistory)
    const turns = input.context === 'light' ? allTurns.slice(-LIGHT_CONTEXT_TURNS) : allTurns
    const assembled = await (deps.assemble ?? assembleContext)({
      userText, conversationId, skill: input.skill, conversationKind: conv?.kind === 'main' ? 'main' : 'thread',
      turns: costTurns(turns), budget: RUNTIME_CONTEXT_BUDGET
    })
    // Budget telemetry — `used`/`droppedTurns` compared against the turn's own persisted
    // `usage` (the ACTUAL contextTokens) for the same conversationId. recordEvent only buffers.
    recordEvent({ kind: 'tool', name: 'memory:assemble', severity: 'info', meta: { used: assembled.used, droppedTurns: assembled.droppedTurns, retrievedCount: assembled.usedMemoryIds.length, conversationId, runId: run.id } })
    const history: AgentMessage[] = keepTrailingTurns(turns, turns.length - assembled.droppedTurns)
    // Cycle 83: a child's registry has no coordinator toolset (depth 1); a top-level segment's
    // spawn_workstreams lists the current subagents models.
    const profile = run.profile === 'headless' ? headlessProfile(run)
      : seg ? (seg.child ? childWorkstreamProfile : coordinatorProfile(await listSubagentModels().catch(() => [])))
        : undefined

    // Cycle 78: on-demand toolsets — what this conversation already loaded + what a job declared.
    const storedToolsets = parseToolsetIds(conv?.activeToolsets ?? [])
    const jobDeclaredToolsets = parseToolsetIds(input.toolsets ?? [])
    // Cycle 82: a workstream segment has its workspace tools pre-loaded (spec §4). Cycle 83 final fix
    // wave (I4): except a CHILD — a child gets the workspace only when
    // its spawn spec listed it (then it is in the child's own toolsets) or it loads it itself.
    const initialToolsets = parseToolsetIds([...storedToolsets, ...jobDeclaredToolsets, ...(seg && !seg.child ? ['workspace'] : [])])
    // M1 (final review, fix round 2): ids declared ONLY by this run's job (not already in the
    // stored column before the turn started). run.ts's `loaded` snapshot is always the FULL
    // current set — initial ∪ anything loaded mid-turn — so onChange's `loaded` argument carries
    // these ids on EVERY fire, not just the first. On a main-thread job run that must never stick
    // (controller ruling), so onChange below drops them from what it unions in. A set Bridget
    // explicitly loads mid-turn that happens to equal one of these is acceptable collateral: the
    // write can't tell "Bridget loaded it" apart from "it's in `loaded` only because the job
    // declared it" — only `storedBefore`/`jobDeclared`, fixed for the whole turn, are known here.
    const mainOnlyJobDeclared = conv?.kind === 'main' ? jobDeclaredToolsets.filter(id => !storedToolsets.includes(id)) : []
    const unavailable = await (deps.unavailableToolsets ?? (() => unavailableGoogleToolsets()))().catch((): ToolsetId[] => ['gmail', 'calendar'])
    // Cycle 83 fix round 1 (M5): a top-level workstream that has loaded `coordinator` (D1: any
    // workstream becomes a coordinator by loading it) gets the coordinator rules from this segment on.
    if (seg && !seg.child && !seg.promptInfo.role && initialToolsets.includes('coordinator')) seg.promptInfo = { ...seg.promptInfo, role: { kind: 'coordinator' } }
    const toolsets = {
      initial: initialToolsets,
      unavailable,
      onChange: async (loaded: ToolsetId[]) => {
        const persistable = mainOnlyJobDeclared.length ? loaded.filter(id => !mainOnlyJobDeclared.includes(id)) : loaded
        // A UNION, never an overwrite: runAgent fires onChange fire-and-forget, so two writes
        // from one step can land out of order and an overwrite could persist the smaller set.
        await useDb().update(conversations).set({
          activeToolsets: sql`(select coalesce(array_agg(distinct x order by x), '{}'::text[]) from unnest(${conversations.activeToolsets} || ${sql.param(persistable)}::text[]) as x)`
        }).where(eq(conversations.id, conversationId))
      }
    }
    // Job-declared sets persist for later turns of an isolated job thread even when runAgent's
    // onChange never fires this turn (nothing new loaded mid-turn). Skipped on the main thread
    // (controller ruling): a main-thread job's declared toolsets must NOT persist onto Bridget's
    // one permanent home thread — they still reach this run via `initial` above, just not written
    // back. onChange (Bridget loading something herself mid-turn) still persists on main too, but
    // (M1) with `persistable` above stripping the job's own declared-only ids back out first.
    if (conv?.kind !== 'main' && initialToolsets.join() !== storedToolsets.join()) {
      // A failed persist must not fail the turn — logged (spec §6), same shape run.ts uses for
      // its own onChange failures, and then dropped.
      await toolsets.onChange(initialToolsets).catch((err: unknown) =>
        recordEvent({ kind: 'tool', name: 'toolsets:persist', status: 'error', severity: 'warn', error: { message: (err as Error).message } }))
    }

    const result = await handleTurn(userText, history, {
      speak, context: assembled.context || undefined, modelDefId: run.modelDefId,
      profile, requestApproval: run.profile === 'interactive' ? approvalFor(run.id) : undefined,
      attachments: turnAttachments, signal: ac.signal, emit, runAgent: deps.runAgent,
      drainSteer: async () => {
        const fresh = await drainInboxFor(run.id)
        // Reports and (final fix wave M2) a coordinator's steer into its child are EVENT rows.
        const originOf = (i: { kind: string }) => i.kind === 'report' ? REPORT_ORIGIN : i.kind === 'coordinator' ? COORDINATOR_ORIGIN : null
        drainedSteers.push(...fresh.map((i): Steer => { const o = originOf(i); return o ? { event: i.text, origin: o } : i.text }))
        // The model reads them exactly as it will read the persisted event rows on every later turn.
        return fresh.map((i) => { const o = originOf(i); return o ? eventModelText(o, i.text) : i.text })
      }, wake: isWake ? { reason: run.wakeReason ?? 'unspecified' } : undefined,
      runId: run.id, toolsets,
      ...(seg ? { maxSteps: seg.maxSteps, shouldStop: seg.shouldStop, onStep: seg.onStep, workstream: seg.promptInfo } : input.maxSteps ? { maxSteps: input.maxSteps } : {}),
      // Cycle 83 (carried C2): a child runs on its subagents chain (label → rest of subagents → reasoning).
      ...(seg?.child ? { subagent: { label: seg.child.modelLabel } } : {}),
      // Cycle 84 final fix wave (C1): a workstream's taint is sticky for its whole life — every segment
      // starts with the stored sources (and a tainted workspace), and a new source is persisted the
      // moment the run gains it, not at segment end.
      ...(seg ? { taint: { initial: seg.initialTaint, onChange: (t: RunTaint) => seg!.markTainted(t.sources) } } : {}),
      // Cycle 84: where this run's approvals are raised — Smart Approvals applies per surface, never
      // to a headless run (a job, a wake).
      approvals: { surface: approvalSurface(run, !!seg), ...(seg ? { workstreamId: seg.workstreamId } : {}) }
    })
    // Finalize the timing ONCE, here, and use the same object for the live chunk below and
    // for the persist further down — so the duration and tok/s the user watches appear are
    // the ones a reload shows, instead of two independently-sampled clocks disagreeing.
    const finalUsage = buildUsageWithTiming()
    // Close the message BEFORE persisting: the UI should finish promptly; persistence
    // (and the `conversation` frame for a new thread) follows.
    if (ac.signal.aborted) ts.abort()
    else {
      // The live `usage` chunk carried tokens and the model id but no timing (see
      // server/lib/voice/ui-stream.ts), so duration and tok/s — a goal of this cycle —
      // only ever showed up after a reload, read back off the persisted row. Re-emitting
      // usage with the timing filled in reuses the message-metadata chunk that was already
      // flowing: no new frame type and no protocol change.
      //
      // Guarded so this can never OPEN a message that never started: `ttftMs !== undefined` OR
      // `turnUsage` implies a chunk already went out (an assistant token, or a usage event), and
      // turn-stream starts the message on the first chunk. Never for a wake: it streams no
      // chunks at all (see `emit` above), so this would open a message just to carry usage.
      if (!isWake && (ttftMs !== undefined || turnUsage)) ts.emit({ type: 'usage', ...finalUsage })
      ts.finish()
    }
    // A wake that answered with the NO_REPLY sentinel — or with nothing (no assistant message,
    // or only whitespace; fix round 1 ruling, same as the rescue path) — is silent, and a silent
    // run leaves NOTHING in the thread (cycle 74 D4 — cycle 73 kept the event row): no rows, no
    // `conversation`/`persisted` frame, no afterPersist. Its agent_runs row (outcome suppressed,
    // which a job reads as 'silent', finished by queue.ts) is the only trace. A wake is headless,
    // so enqueue never steers into it and drainedSteers is empty here — nothing Tony typed can be
    // dropped by this.
    const hasReply = result.length > history.length + 1 // else result's last row is the question
    const reply = hasReply ? messageText(result[result.length - 1]?.content ?? '') : ''
    const suppressed = isWake && (!reply.trim() || isSuppressedReply(reply))
    let added = result.slice(history.length) // [user] or [user, assistant]
    if (suppressed) {
      added = []
      silent = true
    }
    if (ac.signal.aborted) outcome = { status: 'aborted' }
    else outcome = { status: 'done', suppressed, usage: finalUsage }
    if (added.length && !ac.signal.aborted) {
      const created = (await countMessages(conversationId)) === 0
      const payload = buildTurnPersistPayload(added, {
        inputModality,
        speakFlag,
        attachments: turnAttachments,
        origin: input.origin,
        reasoning: reasoningText,
        // The same object the live chunk above carried — see the note there.
        usage: finalUsage
      })
      if (isWake) payload[0] = { ...payload[0]!, role: 'event', origin, content: input.text }
      else if (eventOrigin) payload[0] = { ...payload[0]!, role: 'event', origin: eventOrigin, content: input.text }
      // Steers ride in the SAME append (one transaction, one chain), between the question and
      // the reply — the order the model saw them in, and the reply stays the leaf.
      // A reply that goes out over a channel (reply_to / a job's `deliver`) gets its
      // channel_deliveries rows in the SAME transaction as the message: both or neither.
      // planDeliveries reads reply_to off the row (set at creation only — C1); for a run with
      // neither it plans nothing. Its reads go through this transaction (no second pooled
      // connection), inside a savepoint: a planning failure — even a failed query — rolls back
      // to it and the reply still commits, just without deliveries. The rescue path never delivers
      // the partial reply (a failed iMessage turn gets a short note instead — see the `finally`).
      const deliveryIds: string[] = []
      const ids = await appendMessages(conversationId, withSteers(payload, drainedSteers), turnLeafId, { // insertion order
        inTx: async (tx, newIds) => {
          if (added.length < 2) return
          const plans = await tx.transaction(sp => planDeliveries(run, { text: reply, messageId: newIds[newIds.length - 1]!, conversationId }, sp))
            .catch((err) => { console.error('[agent] planning channel deliveries failed:', err); return [] })
          if (plans.length) deliveryIds.push(...await insertDeliveries(tx, plans))
        }
      })
      for (const id of deliveryIds) publishChange({ resource: 'channelDelivery', action: 'created', id })
      // Set BEFORE anything that can throw below: the rows are committed at this point, and
      // the `finally` rescue below keys off this flag. A `peer.send` to a socket that closed
      // mid-turn would otherwise unwind into the catch with `persisted` still false and make
      // the rescue append the same turn a second time.
      persisted = true
      outcome = { status: 'done', suppressed, usage: finalUsage, userMessageId: ids[0], assistantMessageId: added.length > 1 ? ids[ids.length - 1] : undefined }
      // Tell the client which thread it just landed in. Without this frame the page
      // has no way to learn the id/title the server derived on the first turn — the
      // toolbar kept reading "Bridget" and no rail row highlighted until a reload.
      //
      // SENT AFTER the append above. The page treats the arrival of a
      // conversation id as its cue to re-read the thread (it has to: a live message's id
      // is a stream uuid, not the row id — see app/pages/agent/index.vue), and sending
      // this first meant that read could land before the rows existed and wipe the
      // transcript. Ordering it after the append makes "the client knows the id" imply
      // "the rows are committed".
      if (created) hub.publish(conversationId, JSON.stringify({ type: 'conversation', conversationId, title: conv?.title ?? null }))
      // The page's post-turn re-read is armed by THIS, not by `state:'idle'` — the
      // orchestrator emits idle from inside exec, before the append, so a read armed by idle
      // races the persist and can come back without the rows it went looking for. This is
      // sent once the transaction has returned, on every turn, which is what the first-turn
      // `conversation` frame above only achieved for the first turn of a thread.
      hub.publish(conversationId, JSON.stringify({ type: 'persisted', conversationId }))
      publishChange({ resource: 'conversation', action: created ? 'created' : 'updated', id: conversationId })
    }
  } catch (err) {
    // An abort can surface as some other error (a transport torn down mid-request); the signal
    // is the authority on whether this turn was stopped.
    if ((err as Error).name === 'AbortError' || ac.signal.aborted) {
      ts?.abort()
      return { status: 'aborted' }
    }
    console.error('[agent] turn failed:', err)
    failed = true
    const message = (err as Error).message || 'agent pipeline error'
    if (ts) ts.error(message)
    else {
      hub.publish(conversationId, JSON.stringify({ type: 'error', message }))
      hub.publish(conversationId, JSON.stringify({ type: 'state', state: 'idle' }))
    }
    return { status: 'failed', error: message }
  } finally {
    // A turn that aborted, threw, or hung persisted NOTHING before this — including the
    // user's own message, because `added` comes from handleTurn's `result`, which exists only
    // if the agent call returns. The user saw their question on screen (client-side state) and
    // lost it on reload. A question someone actually asked has to survive the model
    // failing to answer it, so rescue whatever the turn managed to emit.
    if (!persisted && !silent) {
      // `|| input.text`: a turn that failed before handleTurn emitted the user transcript
      // (history load, assembly) still has the question the run was created with.
      // A wake's NO_REPLY is silent by contract on this path too.
      const rescuedReply = isWake && isSuppressedReply(liveAssistantText) ? '' : liveAssistantText
      const question = liveUserText || input.text
      // partialTurnMessages drops a reply that has no question to attribute it to. A blank
      // question with drained steers is not that case: the reply answers the steers, so it is
      // kept, and withSteers puts the steers ahead of it. (An EMPTY question never reaches the
      // model — handleTurn returns early — so only a whitespace-only one can land here.)
      const steered = drainedSteers.some(t => (typeof t === 'string' ? t : t.event).trim())
      // A wake with no (or a suppressed) reply rescues nothing: its event row is meaningless
      // alone (cycle 74 D4, same rule as the success path).
      let rescuedMsgs: AgentMessage[]
      if (isWake && !rescuedReply.trim() && !steered) rescuedMsgs = []
      else if (!question.trim() && steered) rescuedMsgs = rescuedReply.trim() ? [{ role: 'assistant', content: rescuedReply }] : []
      else rescuedMsgs = partialTurnMessages(question, rescuedReply)
      if (rescuedMsgs.length || steered) {
        try {
          const created = (await countMessages(conversationId)) === 0
          const payload = buildTurnPersistPayload(rescuedMsgs, {
            inputModality,
            speakFlag,
            attachments: turnAttachments,
            origin: input.origin,
            reasoning: reasoningText,
            usage: buildUsageWithTiming()
          })
          if (isWake && payload[0]?.role === 'user') payload[0] = { ...payload[0]!, role: 'event', origin, content: input.text }
          else if (eventOrigin && payload[0]?.role === 'user') payload[0] = { ...payload[0]!, role: 'event', origin: eventOrigin, content: input.text }
          await appendMessages(conversationId, withSteers(payload, drainedSteers), turnLeafId)
          rescued = true
          publishChange({ resource: 'conversation', action: created ? 'created' : 'updated', id: conversationId })
          // The rescued rows are real rows, so the page's re-read must be armed for them
          // too — otherwise a turn that errored keeps its stream uuids for good. Last,
          // because a send to a socket that has since closed must not skip publishChange.
          hub.publish(conversationId, JSON.stringify({ type: 'persisted', conversationId }))
        } catch (persistErr) {
          // Last resort only — nothing above this can recover the turn now.
          console.error('[agent] rescuing an unfinished turn failed:', persistErr)
        }
      }
    }
    releaseTurnStream(run.id)
    // The socket that originated this run registered an approval channel for it; drop it here,
    // with the run, rather than only when that socket closes (ws.ts still unregisters on close —
    // both are idempotent).
    unregisterApprovalChannel(run.id)
    releaseAbort(run.id)
    // The segment's clocks stop and its final `used` is persisted before the run is reported
    // finished — onSegmentFinished (queue.ts) decides the next segment from that row.
    if (seg) await seg.end().catch(err => console.error('[agent] ending the workstream segment failed:', err))
    void channelPresence.stop(run)
    // Every frame committed before the run is reported finished (the bus writer flushes here).
    await Promise.resolve(hub.endRun(conversationId)).catch((err: unknown) => console.error('[agent] flushing run frames failed:', err))
    if (persisted || rescued) deps.afterPersist?.(conversationId)
    // The rescue path never delivers the partial reply; a failed turn with a reply chat gets
    // one "sorry" note instead, so the phone isn't left silent (final review I3).
    if (failed) await queueFailureNote(run).catch(err => console.error('[agent] queueing the failure note failed:', err))
  }
  return outcome
}

/** Splices drained steers in as their own user rows right after the turn's question (user or
 *  event row) and before the reply, so the reply stays last — the leaf, and the row
 *  `assistantMessageId` names. Typed steers are always text. With no question row (a rescue
 *  whose question was blank), the steers lead and the reply follows them. */
/** A drained steer: words someone typed (a user row), or a report (an event row with its origin). */
export type Steer = string | { event: string; origin: string }
const REPORT_ORIGIN = 'segment:children'

export function withSteers(payload: NewConvMessage[], steers: Steer[]): NewConvMessage[] {
  const rows: NewConvMessage[] = steers
    .filter(t => (typeof t === 'string' ? t : t.event).trim())
    .map(t => typeof t === 'string' ? { role: 'user', content: t, modality: 'text' } : { role: 'event', content: t.event, modality: 'text', origin: t.origin })
  if (!rows.length) return payload
  const at = payload[0] && payload[0].role !== 'assistant' ? 1 : 0
  return [...payload.slice(0, at), ...rows, ...payload.slice(at)]
}

async function countMessages(conversationId: string): Promise<number> {
  const [r] = await useDb().select({ n: sql<number>`count(*)::int` }).from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId))
  return r?.n ?? 0
}
