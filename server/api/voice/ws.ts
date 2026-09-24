// server/api/voice/ws.ts
import { handleUtterance, handleTurn, type VoiceEvent } from '../../lib/voice/orchestrator'
import { classifyFrame } from '../../lib/voice/frames'
import { sttFromModel } from '../../lib/voice/providers'
import type { SttProvider, TtsProvider } from '../../lib/voice/providers/types'
import { speakWithPreset } from '../../lib/voice/speak'
import { createTurnStream, type TurnStream } from '../../lib/voice/turn-stream'
import { resolveTurnVoice } from '../../services/voice-presets'
import { withFailover } from '../../lib/ai/registry/resolve'
import { messageText } from '../../lib/agent/run'
import type { AgentMessage } from '../../lib/agent/run'
import { buildTurnPersistPayload } from '../../lib/voice/turn-persist'
import { partialTurnMessages } from '../../lib/voice/turn-partial'
import { createConversation, appendMessages, getAgentHistory, deriveTitle, captureTurnLeaf } from '../../services/conversations'
import { assembleContext } from '../../lib/agent/assemble'
import { publishChange } from '../../utils/live-bus'
import type { ApprovalRequest } from '../../lib/agent/types'
import { loadApprovals, addApproval, touchApproval, matchesApproval, approvalOutcome } from '../../lib/exec/approvals'
import { recordEvent } from '../../lib/observability/record'
import { randomUUID } from 'node:crypto'
import type { AttachmentRef } from '../../lib/agent/attachments'
import { denyPendingApprovals } from '../../lib/voice/pending-approvals'

// Client→server: binary frame = one WAV utterance | text JSON {type:'interrupt'} |
//   {type:'preset',presetId} (voice pick; null/absent = the default preset) |
//   {type:'model',modelDefId} (ephemeral reasoning-model override; null clears) |
//   {type:'text',text,speak?} (typed turn, injected post-STT) |
//   {type:'load',conversationId} (load existing conversation) | {type:'new'} (reset) |
//   {type:'approve'|'deny',requestId,...} (resolve a pending exec approval)
// Server→client: binary = raw PCM (s16le mono) for the segment currently open |
//   text JSON = {type:'audio-begin',turnId,segmentId,sampleRate} / {type:'audio-end',segmentId}
//   (bracket each spoken segment) | {type:'state',state} |
//   {type:'chunk',turnId,chunk} (an AI SDK UIMessageChunk for the turn's assistant message) |
//   {type:'user-message',turnId,message} (the turn's user message, once, before its chunks) |
//   {type:'approval'|'approval-resolved',...} (exec approval lifecycle) |
//   {type:'conversation',conversationId,title} (emitted once, when the first turn lazily creates the thread) |
//   {type:'error',message} (turn failure; always followed by {type:'state',state:'idle'}).
interface ConnState {
  history: AgentMessage[]
  ac: AbortController | null
  /** Voice preset the client picked (cookie-backed); null = fall back to the default row. */
  presetId: string | null
  model: string | null
  lock: Promise<void>
  conversationId: string | null
  pendingApprovals: Map<string, { resolve: (d: { approved: boolean }) => void; timer: ReturnType<typeof setTimeout>; req: ApprovalRequest }>
  /** Monotonic per-connection turn counter; stamped onto every frame of a turn so the client
   *  can drop a superseded turn's stragglers. */
  turnSeq: number
  /** The turn stream currently running, if any — lets requestApproval emit the
   *  approval-request chunk straight into the active turn's message stream. */
  activeTurn: TurnStream | null
}
const conns = new WeakMap<object, ConnState>()

// STT/TTS resolved from the registry at call time, with per-usage failover.
const stt: SttProvider = {
  transcribe: (audio, opts) =>
    withFailover('stt', m => sttFromModel(m).transcribe(audio, opts))
}
// TTS: Breeze only. No failover chain — one engine, resolved from the registry's tts
// assignment inside speakWithPreset.
const tts: TtsProvider = {
  synthesize: (text, opts) => speakWithPreset(text, opts.preset, 'agent', opts.signal, opts.refAudio ?? null)
}

export default defineWebSocketHandler({
  // Server middleware does NOT run for WS upgrades (crossws handles them directly),
  // so the session must be validated here — this socket drives the full agent.
  // Returning a non-ok Response makes crossws reject the upgrade.
  async upgrade(request) {
    const session = await useAuth().api.getSession({ headers: request.headers as Headers }).catch(() => null)
    if (!session?.user) return new Response('Unauthorized', { status: 401 })
  },
  open(peer) {
    conns.set(peer, { history: [], ac: null, presetId: null, model: null, lock: Promise.resolve(), conversationId: null, pendingApprovals: new Map(), turnSeq: 0, activeTurn: null })
  },
  message(peer, message) {
    const s = conns.get(peer); if (!s) return
    // Classify by CONTENT, not transport type: crossws@0.3.5's node adapter drops
    // the isBinary flag, so JSON control frames arrive as Buffers (see frames.ts).
    const frame = classifyFrame(typeof message.rawData === 'string' ? message.rawData : message.uint8Array())
    if (frame.kind === 'ignore') return
    // A turn closure reads s.history at EXECUTION time (under the lock), so
    // back-to-back turns see each other's appended messages.
    let turn: ((signal: AbortSignal, emit: (e: VoiceEvent) => void, context: string | undefined) => Promise<AgentMessage[]>) | null = null
    let inputModality: 'text' | 'voice' = 'text'
    let speakFlag = false
    let turnAttachments: AttachmentRef[] = []
    // Assembler-backed proactive memory injection, shadowing the plain buildMemoryContext
    // import (removed above) — both turn closures below reference this name unchanged, so
    // this one definition is the entire wiring change. `s.conversationId` is `string | null`;
    // AssembleInput.conversationId is `string | undefined`, hence the `?? undefined`.
    const buildMemoryContext = async (userText: string) => {
      const assembled = await assembleContext({ userText, conversationId: s.conversationId ?? undefined })
      // Budget telemetry — same recordEvent/activity-log channel exec:approval below already
      // uses, not a new one. `used`/`droppedTurns` previously went nowhere, so there was no
      // production signal comparing estimated vs actual token cost (the turn's own `usage`
      // event/persisted row carries the ACTUAL contextTokens, for the same conversationId, to
      // compare against). Kept cheap: recordEvent only buffers in memory here.
      recordEvent({
        kind: 'tool', name: 'memory:assemble', severity: 'info',
        meta: { used: assembled.used, droppedTurns: assembled.droppedTurns, retrievedCount: assembled.usedMemoryIds.length, conversationId: s.conversationId ?? null }
      })
      return assembled.context
    }
    // Approval channel for dangerous tools: allowlist check → run; else emit an
    // approval request to the peer and await Tony's decision (120s auto-deny).
    // Computed unconditionally so both text + audio turn branches can reference them.
    const requestApproval = async (req: ApprovalRequest): Promise<{ approved: boolean }> => {
      const patterns = (await loadApprovals(req.tool)).filter(p => matchesApproval(req.command, [p.pattern]))
      if (patterns.length) {
        touchApproval(patterns[0]!.id).catch(() => {})
        recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'info', meta: { outcome: 'allowlisted', command: req.command, pattern: patterns[0]!.pattern } })
        return { approved: true }
      }
      const requestId = randomUUID()
      return await new Promise<{ approved: boolean }>((resolve) => {
        const timer = setTimeout(() => {
          if (s.pendingApprovals.delete(requestId)) {
            recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'warn', meta: { outcome: 'timeout', command: req.command } })
            peer.send(JSON.stringify({ type: 'approval-resolved', requestId }))
            resolve({ approved: false })
          }
        }, Number(process.env.APPROVAL_TIMEOUT_MS ?? 120_000))
        s.pendingApprovals.set(requestId, { resolve, timer, req })
        peer.send(JSON.stringify({ type: 'approval', requestId, tool: req.tool, command: req.command, proposedPattern: req.proposedPattern }))
        if (req.callId) s.activeTurn?.emit({ type: 'approval-request', approvalId: requestId, callId: req.callId, name: req.tool })
      })
    }
    // Deny every pending approval and tell the client each request is resolved — used
    // whenever the turn that asked for them is abandoned (interrupt / new / a fresh turn /
    // socket close) so a tool never waits out its 120s timeout on a question nobody can see.
    const denyAll = () => { for (const id of denyPendingApprovals(s.pendingApprovals)) peer.send(JSON.stringify({ type: 'approval-resolved', requestId: id })) }
    if (frame.kind === 'control') {
      const msg = frame.msg
      if (msg.type === 'interrupt') { s.ac?.abort(); denyAll(); return }
      if (msg.type === 'preset') {
        s.presetId = typeof msg.presetId === 'string' && msg.presetId ? msg.presetId : null
        return
      }
      if (msg.type === 'model') { s.model = typeof msg.modelDefId === 'string' ? msg.modelDefId : null; return }
      // 'profile' / 'execEnabled' frames from old clients are silently ignored —
      // the agent is always fully armed now (single profile; approval gate = safety).
      // Approve/deny resolve a pending approval IMMEDIATELY (like interrupt) — not
      // queued behind the turn lock, so the awaiting turn unblocks.
      if (msg.type === 'approve' || msg.type === 'deny') {
        const id = typeof msg.requestId === 'string' ? msg.requestId : ''
        const pending = s.pendingApprovals.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          s.pendingApprovals.delete(id)
          const outcome = approvalOutcome(
            msg.type === 'approve'
              ? { kind: 'approve', remember: !!msg.remember, pattern: typeof msg.pattern === 'string' ? msg.pattern : undefined, proposedPattern: pending.req.proposedPattern }
              : { kind: 'deny' }
          )
          if (outcome.persist && outcome.pattern) {
            addApproval({ pattern: outcome.pattern, tool: pending.req.tool }).catch(err => console.error('[exec] persist approval failed:', err))
          }
          recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'info', meta: { outcome: msg.type, command: pending.req.command, pattern: outcome.pattern, remembered: outcome.persist } })
          pending.resolve({ approved: outcome.approved })
        }
        return
      }
      // load: restore a previous conversation under the lock so history is consistent.
      // Abort any running turn and deny its pending approvals BEFORE queuing the load —
      // same as 'new' — or a turn awaiting approval blocks the load behind the lock for up
      // to 120s, and the approval prompt (now for a thread the client has already swapped
      // away from) sits invisible the whole time.
      if (msg.type === 'load' && typeof msg.conversationId === 'string') {
        s.ac?.abort()
        denyAll()
        s.lock = s.lock.then(async () => {
          try {
            s.history = await getAgentHistory(msg.conversationId as string)
            s.conversationId = msg.conversationId as string
          } catch (err) {
            console.error('[agent] load failed:', err)
            peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'failed to load conversation' }))
          }
        })
        return
      }
      // new: reset to a fresh conversation — also abandons any turn in flight, so its
      // pending approvals (and the turn itself) don't linger into the new conversation.
      if (msg.type === 'new') { s.ac?.abort(); denyAll(); s.history = []; s.conversationId = null; return }
      if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
        // Typed turn: inject post-STT — same agent loop, same TTS, same events.
        const text = msg.text.trim()
        const speak = typeof msg.speak === 'boolean' ? msg.speak : false
        const attachments = Array.isArray(msg.attachments) ? (msg.attachments as AttachmentRef[]) : []
        turnAttachments = attachments
        inputModality = 'text'
        speakFlag = speak
        turn = async (signal, emit, context) => {
          // Total by construction — a silent turn touches no voice state, and neither a
          // DB nor a storage failure can propagate out of here. Voice degrades to "no
          // audio"; it must never degrade to "no turn". See resolveTurnVoice.
          const { preset, refAudio } = await resolveTurnVoice(s.presetId, speak)
          return handleTurn(text, s.history, { tts, preset, refAudio, speak, context, modelDefId: s.model, buildMemoryContext, requestApproval, attachments, signal, emit })
        }
      } else {
        return
      }
    } else {
      const audio = frame.bytes
      inputModality = 'voice'
      speakFlag = true
      turn = async (signal, emit, context) => {
        const { preset, refAudio } = await resolveTurnVoice(s.presetId, true)
        return handleUtterance(audio, s.history, { stt, tts, preset, refAudio, speak: true, context, modelDefId: s.model, buildMemoryContext, requestApproval, signal, emit })
      }
    }
    const turnId = ++s.turnSeq
    const attachmentsForTurn = turnAttachments
    s.ac?.abort()
    denyAll()
    s.ac = new AbortController()
    const ac = s.ac
    const exec = turn
    const run = async () => {
      let ts: ReturnType<typeof createTurnStream> | null = null
      // Declared out here so the `finally` rescue can still see them when the turn throws.
      let reasoningText = ''
      let turnUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; contextTokens?: number; modelDefId?: string } | null = null
      let liveUserText = ''
      let liveAssistantText = ''
      const turnStart = Date.now()
      let ttftMs: number | undefined
      let turnConversationIdForRescue: string | null = s.conversationId
      // The branch this turn was actually typed into. `appendMessages` reads
      // conversations.active_leaf_id at PERSIST time, but PATCH /api/conversations/:id/leaf
      // (cycle 68) can move that column mid-turn — from another tab, or the user switching
      // branches while a reply is still streaming. Captured once, beside
      // turnConversationIdForRescue, so both the success and rescue appends chain from the
      // branch the user was reading, not wherever the leaf drifted to by the time this
      // persists. This only fixes CHAINING — the leaf still moves to the new reply
      // afterwards regardless (a ruled UX tradeoff, not a bug: both branches stay reachable).
      let turnLeafId: string | undefined
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
      try {
        // Live state is now assembled exactly once per turn, inside assembleContext
        // (buildMemoryContext below) — that is the single fixed 'live' tier, budgeted
        // alongside resident memories and retrieval. Building it again here would inject
        // a second, unbudgeted copy of the same "Current context / Active projects / Open
        // tasks" block into every prompt (and pay its two indexed queries twice); see
        // orchestrator.ts's `context` construction, which concatenates this value with
        // buildMemoryContext's output.
        const prevLen = s.history.length
        ts = createTurnStream({ turnId, attachments: attachmentsForTurn, send: d => peer.send(d) })
        // Active while this turn runs, so requestApproval (fired from inside exec!) can emit
        // the approval-request chunk into THIS turn's stream — turns are serialized by
        // s.lock, so the turn calling requestApproval is always the active one.
        s.activeTurn = ts
        const emit = (e: VoiceEvent) => {
          if (e.type === 'transcript') {
            if (e.role === 'user') liveUserText = e.text
            else {
              // First assistant token: the wait before this is model latency, not generation.
              if (ttftMs === undefined) ttftMs = Date.now() - turnStart
              liveAssistantText += e.text
            }
          }
          if (e.type === 'reasoning') reasoningText += e.text
          // Overwrite, not accumulate: at most one usage event per turn in the common
          // case, and if the rare forced-final recovery path (run.ts) yields a second
          // one, it's from the streamText call that actually produced the visible text —
          // that supersedes the aborted first call's usage rather than adding to it.
          else if (e.type === 'usage') turnUsage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens, totalTokens: e.totalTokens, contextTokens: e.contextTokens, modelDefId: e.modelDefId }
          ts!.emit(e)
        }
        // The thread this turn was SENT to. Captured before the await so a mid-turn `new`
        // (which nulls s.conversationId) cannot redirect a rescued turn into a different
        // thread than the one the user was typing in.
        turnConversationIdForRescue = s.conversationId
        // The branch this turn was sent into, same reasoning — read now, before the turn's
        // own await, not at persist time.
        if (turnConversationIdForRescue) turnLeafId = await captureTurnLeaf(turnConversationIdForRescue)
        s.history = await exec!(ac.signal, emit, undefined)
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
          // Guarded so this can never OPEN a message that never started: both conditions imply
          // a chunk already went out (a usage event, or an assistant token that set ttftMs), and
          // turn-stream starts the message on the first chunk.
          if (turnUsage || ttftMs !== undefined) ts.emit({ type: 'usage', ...finalUsage })
          ts.finish()
        }
        const added = s.history.slice(prevLen)                // [user] or [user, assistant]
        if (added.length && !ac.signal.aborted) {
          const created = prevLen === 0 && !s.conversationId
          let newThreadFrame: string | null = null
          if (!s.conversationId) {
            const title = deriveTitle(messageText(added[0]!.content))
            s.conversationId = (await createConversation({ title })).id
            // Tell the client which thread it just landed in. Without this frame the page
            // has no way to learn the id/title the server derived on the first turn — the
            // toolbar kept reading "Bridget" and no rail row highlighted until a reload.
            //
            // Built here but SENT AFTER the append below. The page treats the arrival of a
            // conversation id as its cue to re-read the thread (it has to: a live message's id
            // is a stream uuid, not the row id — see app/pages/agent/index.vue), and sending
            // this first meant that read could land before the rows existed and wipe the
            // transcript. Ordering it after the append makes "the client knows the id" imply
            // "the rows are committed".
            newThreadFrame = JSON.stringify({ type: 'conversation', conversationId: s.conversationId, title })
          }
          await appendMessages(s.conversationId, buildTurnPersistPayload(added, {
            inputModality,
            speakFlag,
            attachments: turnAttachments,
            reasoning: reasoningText,
            // The same object the live chunk above carried — see the note there.
            usage: finalUsage
          }), turnLeafId)
          // Set BEFORE anything that can throw below: the rows are committed at this point, and
          // the `finally` rescue below keys off this flag. A `peer.send` to a socket that closed
          // mid-turn would otherwise unwind into the catch with `persisted` still false and make
          // the rescue append the same turn a second time.
          persisted = true
          if (newThreadFrame) peer.send(newThreadFrame)
          // The page's post-turn re-read is armed by THIS, not by `state:'idle'` — the
          // orchestrator emits idle from inside exec, before the append, so a read armed by idle
          // races the persist and can come back without the rows it went looking for. This is
          // sent once the transaction has returned, on every turn, which is what the first-turn
          // `conversation` frame above only achieved for the first turn of a thread.
          peer.send(JSON.stringify({ type: 'persisted', conversationId: s.conversationId }))
          publishChange({ resource: 'conversation', action: created ? 'created' : 'updated', id: s.conversationId })
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') { ts?.abort(); return }
        console.error('[agent] turn failed:', err)
        if (ts) ts.error((err as Error).message || 'agent pipeline error')
        else {
          peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'agent pipeline error' }))
          peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
        }
      } finally {
        // A turn that aborted, threw, or hung persisted NOTHING before this — including the
        // user's own message, because `added` comes from s.history, which the agent call only
        // reassigns on return. The user saw their question on screen (client-side state) and
        // lost it on reload. A question someone actually asked has to survive the model
        // failing to answer it, so rescue whatever the turn managed to emit.
        if (!persisted) {
          const rescued = partialTurnMessages(liveUserText, liveAssistantText)
          if (rescued.length) {
            try {
              let convId = turnConversationIdForRescue
              const created = !convId
              if (!convId) {
                const title = deriveTitle(messageText(rescued[0]!.content))
                convId = (await createConversation({ title })).id
                // Only adopt it as the live thread if the connection has not moved on.
                if (!s.conversationId) s.conversationId = convId
              }
              await appendMessages(convId, buildTurnPersistPayload(rescued, {
                inputModality,
                speakFlag,
                attachments: turnAttachments,
                reasoning: reasoningText,
                usage: buildUsageWithTiming()
              }), turnLeafId)
              publishChange({ resource: 'conversation', action: created ? 'created' : 'updated', id: convId })
              // The rescued rows are real rows, so the page's re-read must be armed for them
              // too — otherwise a turn that errored keeps its stream uuids for good. Last,
              // because a send to a socket that has since closed must not skip publishChange.
              peer.send(JSON.stringify({ type: 'persisted', conversationId: convId }))
            } catch (persistErr) {
              // Last resort only — nothing above this can recover the turn now.
              console.error('[agent] rescuing an unfinished turn failed:', persistErr)
            }
          }
        }
        if (s.activeTurn === ts) s.activeTurn = null
      }
    }
    s.lock = s.lock.then(run, run)
  },
  close(peer) {
    const s = conns.get(peer)
    s?.ac?.abort()
    if (s) {
      for (const id of denyPendingApprovals(s.pendingApprovals)) {
        // The socket is closing (or already closed) — sending is best-effort.
        try { peer.send(JSON.stringify({ type: 'approval-resolved', requestId: id })) } catch { /* ignore */ }
      }
    }
    conns.delete(peer)
  }
})
