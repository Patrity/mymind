// server/api/voice/ws.ts
// Thin socket: auth, STT, voice/model choice, approvals UI, and frame routing. Turns do NOT
// live here any more — they are runs in server/lib/agent/runtime, which outlive this socket.
// Closing the tab unsubscribes; it never aborts. Stop ('interrupt') is the only abort.
import { randomUUID } from 'node:crypto'
import { classifyFrame } from '../../lib/voice/frames'
import { sttFromModel } from '../../lib/voice/providers'
import type { SttProvider } from '../../lib/voice/providers/types'
import { withFailover } from '../../lib/ai/registry/resolve'
import { VOICE_TUNING } from '../../lib/voice/tuning'
import { routeFrame } from '../../lib/voice/ws-routing'
import { enqueue, abortActive, abortActiveAndWait } from '../../lib/agent/runtime/queue'
import { abortRun } from '../../lib/agent/runtime/aborts'
import { hub, withCid, type Sink } from '../../lib/agent/runtime/stream'
import { registerApprovalChannel, unregisterApprovalChannel, hasApprovalChannel, turnStreamFor } from '../../lib/agent/runtime/approvals'
import { clearConversationContext } from '../../services/conversation-clear'
import { useDb } from '../../db'
import { conversations } from '../../db/schema'
import { eq } from 'drizzle-orm'
import type { ApprovalRequest } from '../../lib/agent/types'
import type { AttachmentRef } from '../../lib/agent/attachments'
import { addApproval, approvalOutcome } from '../../lib/exec/approvals'
import { recordEvent } from '../../lib/observability/record'
import { denyPendingApprovals } from '../../lib/voice/pending-approvals'

// Client→server: binary frame = one WAV utterance (transcribed HERE, then run as an ordinary
//   voice turn) | text JSON {type:'interrupt'} (Stop: abort the viewed thread's running
//   turn, this socket's last queued turn on it, and a turn whose enqueue is still in flight —
//   the ONLY abort; closing the tab, `load` and `new` never abort) |
//   {type:'preset',presetId} (voice pick; null/absent = the default preset) |
//   {type:'model',modelDefId} (ephemeral reasoning-model override; null clears) |
//   {type:'text',text,speak?,skill?,conversationId?} (typed turn; `skill` names a `skill`-kind
//   `/`-command the composer resolved to — see assembleContext's `skill` input. `conversationId`
//   is the thread the client is showing; when present (a UUID) it WINS over this socket's own
//   view, so a socket that lost its state — every reconnect starts with none — can never send
//   the words into a new invisible thread. Sent while a turn is running on the thread, plain
//   text is STEERED into that turn; text with attachments or a skill queues its own run) |
//   {type:'load',conversationId} (select a thread: unsubscribes from the previous one and
//   remembers this one, but does NOT subscribe and does NOT abort anything) |
//   {type:'attach'} (subscribe to the selected thread AND replay its running turn so far, in one
//   synchronous step — so no live chunk can arrive before the replay and then be duplicated by
//   it. The client sends this after it has committed the thread's persisted transcript; a
//   socket that never attaches receives no live frames for a loaded thread until it sends text) |
//   {type:'new'} (stop viewing; the next text starts a new thread. Does NOT abort) |
//   {type:'clear'} (forget this conversation's transcript — writes an epoch, deletes
//   nothing; a no-op if there is no conversation yet; aborts the thread's running turn and
//   waits for it to unwind first, so its rescued rows land before the epoch) |
//   {type:'approve'|'deny',requestId,...} (resolve a pending exec approval)
// Server→client: binary = raw PCM (s16le mono) for the segment currently open — only to the
//   socket that originated the turn |
//   text JSON = {type:'audio-begin',turnId,segmentId,sampleRate} / {type:'audio-end',segmentId}
//   (bracket each spoken segment; originating socket only) | {type:'state',state} |
//   {type:'chunk',turnId,chunk} (an AI SDK UIMessageChunk for the turn's assistant message) |
//   {type:'user-message',turnId,message} (the turn's user message, once, before its chunks) |
//   {type:'steered',text,cid} (this socket's text was spliced into the running turn, not queued;
//   `cid` names the thread and the client's cid guard gates it; for a voice utterance it is
//   followed by {type:'state',state:'idle'}) |
//   {type:'queued',text,cid} (this socket's text became its own run QUEUED behind the thread's
//   running run — a headless wake, typically — so the client paints its bubble now; `cid` names
//   the thread, and the client's cid guard gates it like any conversation-scoped frame. Followed
//   by {type:'state',state:'idle'} for a voice utterance, same as `steered`) |
//   {type:'approval'|'approval-resolved',...} (exec approval lifecycle) |
//   {type:'conversation',conversationId,title} (emitted once, when the first turn of a new thread persists) |
//   {type:'persisted',conversationId} (the turn's rows are committed — arms the page's re-read) |
//   {type:'cleared',epochAt} (the /clear boundary; the UI anchors a divider here — epochAt is
//   null when there was nothing to clear, which the UI reads as "no-op", not a failure) |
//   {type:'error',message} (turn failure; always followed by {type:'state',state:'idle'}).
interface PendingApproval {
  resolve: (d: { approved: boolean }) => void
  timer: ReturnType<typeof setTimeout>
  req: ApprovalRequest
  /** The run that asked, and its thread — Stop only denies approvals of the thread in view. */
  runId: string
  conversationId: string
}
interface ConnState {
  sink: Sink
  /** Voice preset the client picked (cookie-backed); null = fall back to the default row. */
  presetId: string | null
  model: string | null
  /** The thread this socket is viewing; null = the next message starts a new side thread. */
  conversationId: string | null
  /** Non-null iff this socket is subscribed to `conversationId`'s live frames. */
  unsubscribe: (() => void) | null
  /** Bumped on every change of what this socket views (load / new / view()). An enqueue that
   *  was in flight across a bump must not re-point the socket at its own thread. */
  viewSeq: number
  /** Bumped by Stop. An enqueue in flight across a bump aborts the run it just created. */
  stopSeq: number
  /** Serialises the ENQUEUE step of submits (not the turns): two back-to-back submits on a
   *  new thread must land in one thread, not race each other into two. */
  submitLock: Promise<unknown>
  /** The last run this socket queued — Stop aborts it too, even if it has not started yet. */
  lastRun: { id: string; conversationId: string } | null
  /** Runs this socket originated that still hold an approval channel — dropped on close. The
   *  runner drops a channel when its run ends; entries whose channel is gone are pruned. */
  runs: Set<string>
  pendingApprovals: Map<string, PendingApproval>
}
const conns = new WeakMap<object, ConnState>()

// STT resolved from the registry at call time, with per-usage failover. (TTS moved to the
// runner, which speaks only while the originating socket is still attached.)
const stt: SttProvider = { transcribe: (audio, opts) => withFailover('stt', m => sttFromModel(m).transcribe(audio, opts)) }

function select(s: ConnState, conversationId: string | null) {
  s.unsubscribe?.(); s.unsubscribe = null
  s.conversationId = conversationId
  s.viewSeq++
}
/** Select AND subscribe, replaying the running turn so far — one synchronous step, so no live
 *  frame can slip in between the subscribe and the replay. Subscribes with a `withCid`-wrapped
 *  sink (tags every chunk/user-message/audio-begin frame with `conversationId`) — belt and
 *  braces for the client's own turn-id tracking; see stream.ts's `withCid` doc comment. */
function view(s: ConnState, conversationId: string | null) {
  select(s, conversationId)
  if (conversationId) s.unsubscribe = hub.subscribe(conversationId, withCid(conversationId, s.sink), { replay: true })
}

export default defineWebSocketHandler({
  // Server middleware does NOT run for WS upgrades (crossws handles them directly),
  // so the session must be validated here — this socket drives the full agent.
  // Returning a non-ok Response makes crossws reject the upgrade.
  async upgrade(request) {
    const session = await useAuth().api.getSession({ headers: request.headers as Headers }).catch(() => null)
    if (!session?.user) return new Response('Unauthorized', { status: 401 })
  },
  // open/close stay synchronous (crossws); only message may await.
  open(peer) {
    conns.set(peer, {
      sink: { id: randomUUID(), send: d => peer.send(d) },
      presetId: null, model: null, conversationId: null, unsubscribe: null,
      viewSeq: 0, stopSeq: 0, submitLock: Promise.resolve(), lastRun: null,
      runs: new Set(), pendingApprovals: new Map()
    })
  },
  async message(peer, message) {
    const s = conns.get(peer); if (!s) return
    // Classify by CONTENT, not transport type: crossws@0.3.5's node adapter drops
    // the isBinary flag, so JSON control frames arrive as Buffers (see frames.ts).
    const frame = classifyFrame(typeof message.rawData === 'string' ? message.rawData : message.uint8Array())
    if (frame.kind === 'ignore') return

    // Interactive approval prompt for one run this socket originated. The persisted allowlist
    // is checked BEFORE this, in runtime/approvals.ts's approvalFor, so it applies even after
    // this socket is gone; only a command that needs Tony reaches here. Emit an approval
    // request to the peer and await Tony's decision (120s auto-deny).
    const requestApproval = (runId: string, conversationId: string) => async (req: ApprovalRequest): Promise<{ approved: boolean }> => {
      const requestId = randomUUID()
      return await new Promise<{ approved: boolean }>((resolve) => {
        const timer = setTimeout(() => {
          if (s.pendingApprovals.delete(requestId)) {
            recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'warn', meta: { outcome: 'timeout', command: req.command } })
            peer.send(JSON.stringify({ type: 'approval-resolved', requestId }))
            resolve({ approved: false })
          }
        }, Number(process.env.APPROVAL_TIMEOUT_MS ?? 120_000))
        s.pendingApprovals.set(requestId, { resolve, timer, req, runId, conversationId })
        peer.send(JSON.stringify({ type: 'approval', requestId, tool: req.tool, command: req.command, proposedPattern: req.proposedPattern }))
        if (req.callId) turnStreamFor(runId)?.emit({ type: 'approval-request', approvalId: requestId, callId: req.callId, name: req.tool })
      })
    }
    // Deny the pending approvals of one thread's runs and tell the client each request is
    // resolved — used whenever the turn that asked for them is abandoned (interrupt / clear) so a
    // tool never waits out its 120s timeout on a question nobody can see. Approvals belonging to
    // another thread's run are left alone: Stop in thread B must not deny thread A's question.
    const denyFor = (conversationId: string | null) => {
      const hit = new Map([...s.pendingApprovals].filter(([, p]) => p.conversationId === conversationId))
      for (const id of hit.keys()) s.pendingApprovals.delete(id)
      for (const id of denyPendingApprovals(hit)) peer.send(JSON.stringify({ type: 'approval-resolved', requestId: id }))
    }

    const submit = (text: string, o: { speak: boolean; skill?: string; attachments: AttachmentRef[]; modality: 'text' | 'voice'; conversationId?: string }): Promise<'started' | 'steered' | 'queued' | 'error'> => {
      // Captured BEFORE queuing on the lock: a Stop pressed while this submit waits its turn
      // behind another enqueue still means "don't run this".
      const stopAt = s.stopSeq
      const job = s.submitLock.then(async (): Promise<'started' | 'steered' | 'queued' | 'error'> => {
        // The client named the thread it is showing (final review C1): after a reconnect this
        // socket's view is null, and without this the text would start a new thread the client
        // never sees (its cid guard drops every frame of it). Re-point the view first — select,
        // not view: the subscribe (with replay) happens below, exactly as for a loaded thread
        // that never attached — and before `seq` is read, so it is not mistaken for navigation.
        if (o.conversationId && o.conversationId !== s.conversationId) select(s, o.conversationId)
        // Read under the lock, so a second submit on a new thread sees the thread the first
        // one created instead of racing it into a second 'thread:new'.
        const viewing = s.conversationId
        const seq = s.viewSeq
        try {
          const r = await enqueue({
            sessionKey: viewing ? `thread:${viewing}` : 'thread:new',
            trigger: 'user', profile: 'interactive', modelDefId: s.model, originSinkId: s.sink.id,
            input: { text, modality: o.modality, speak: o.speak, skill: o.skill, attachments: o.attachments, presetId: s.presetId }
          })
          const stillViewing = s.viewSeq === seq
          if (!r.steered) {
            for (const id of s.runs) if (!hasApprovalChannel(id)) s.runs.delete(id)
            s.runs.add(r.runId)
            registerApprovalChannel(r.runId, requestApproval(r.runId, r.conversationId))
            s.lastRun = { id: r.runId, conversationId: r.conversationId }
            // Stop landed while the enqueue was in flight (and the socket is still on this
            // thread): the run just created is what Stop meant. abortRun's preAborted path
            // covers a run that has not started yet.
            if (s.stopSeq !== stopAt && stillViewing) abortRun(r.runId)
          }
          // Only follow the run if the socket has not moved on (load / new) during the await —
          // otherwise this would undo the user's navigation. Subscribe too when the socket is on
          // this thread but never attached (a loaded thread), or it would see nothing live.
          if (stillViewing && (r.conversationId !== s.conversationId || !s.unsubscribe)) view(s, r.conversationId)
          // Tagged with its thread: conversation-scoped, so the client's cid guard drops a steer
          // bubble for a thread the socket has since navigated away from.
          if (r.steered) {
            peer.send(JSON.stringify({ type: 'steered', text, cid: r.conversationId }))
            return 'steered'
          }
          // Queued behind a running run (cycle 74): its own user-message frame only comes when
          // that run STARTS — minutes away behind a wake — so without this the words vanish.
          if (r.queuedBehind) {
            peer.send(JSON.stringify({ type: 'queued', text, cid: r.conversationId }))
            return 'queued'
          }
          return 'started'
        } catch (err) {
          peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'could not start the turn' }))
          peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
          return 'error'
        }
      })
      s.submitLock = job.catch(() => {})
      return job
    }

    if (frame.kind !== 'control') {
      // Voice: transcribe HERE, then it is an ordinary run. STT used to happen inside the turn,
      // under the lock; now the run only ever sees text. Voice always speaks (as legacy did).
      try {
        peer.send(JSON.stringify({ type: 'state', state: 'thinking' }))
        const text = (await stt.transcribe(frame.bytes, { language: VOICE_TUNING.stt.language })).trim()
        if (!text) { peer.send(JSON.stringify({ type: 'state', state: 'idle' })); return }
        // A steered utterance starts no turn of its own, and a queued one none yet, so nothing
        // else will move this socket out of the 'thinking' state it just entered.
        const how = await submit(text, { speak: true, attachments: [], modality: 'voice' })
        if (how === 'steered' || how === 'queued') {
          peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
        }
      } catch (err) {
        peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'transcription failed' }))
        peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
      }
      return
    }

    const a = routeFrame(frame.msg)
    switch (a.kind) {
      case 'abort': {
        const viewing = s.conversationId
        s.stopSeq++
        // hasApprovalChannel: the runner drops the channel when the run ends, so this skips a
        // long-finished run (abortRun would only park its id in the preAborted set).
        if (s.lastRun && s.lastRun.conversationId === viewing && hasApprovalChannel(s.lastRun.id)) abortRun(s.lastRun.id)
        if (viewing) await abortActive(viewing)
        denyFor(viewing)
        return
      }
      case 'preset': s.presetId = a.presetId; return
      case 'model': s.model = a.modelDefId; return
      // load / new only change what this socket VIEWS. The thread's running turn (if any)
      // keeps going and persists. `load` does not subscribe: `attach` (sent once the client has
      // committed the persisted transcript) subscribes + replays atomically, so a live chunk can
      // never arrive before the replay and then be duplicated by it.
      case 'load': select(s, a.conversationId); return
      case 'attach': if (s.conversationId) view(s, s.conversationId); return
      case 'new': select(s, null); return
      case 'text': await submit(a.text, { speak: a.speak, skill: a.skill, attachments: a.attachments, modality: 'text', conversationId: a.conversationId }); return
      // Approve/deny resolve a pending approval IMMEDIATELY (like interrupt), so the awaiting
      // turn unblocks.
      case 'approve': case 'deny': {
        const id = a.requestId
        const pending = s.pendingApprovals.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          s.pendingApprovals.delete(id)
          const outcome = approvalOutcome(
            a.kind === 'approve'
              ? { kind: 'approve', remember: a.remember, pattern: a.pattern, proposedPattern: pending.req.proposedPattern }
              : { kind: 'deny' }
          )
          if (outcome.persist && outcome.pattern) {
            addApproval({ pattern: outcome.pattern, tool: pending.req.tool }).catch(err => console.error('[exec] persist approval failed:', err))
          }
          recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'info', meta: { outcome: a.kind, command: pending.req.command, pattern: outcome.pattern, remembered: outcome.persist } })
          pending.resolve({ approved: outcome.approved })
        }
        return
      }
      // clear: `/clear` — forgets the transcript for the MODEL only (clearConversationContext
      // deletes nothing; getConversation still returns everything). A brand-new thread with no
      // conversation yet has nothing to clear — that is a no-op, not an error, so it gets its
      // own `{type:'cleared',epochAt:null}` rather than the `{type:'error'}` channel; the client
      // reads a null epochAt as "nothing happened" and says so with a toast, not an alert.
      case 'clear': {
        const id = s.conversationId
        if (!id) { peer.send(JSON.stringify({ type: 'cleared', epochAt: null })); return }
        // Deny this thread's pending approvals FIRST: the exec tool's approval await does not race
        // the abort signal, so a run parked on one would not unwind until it resolves — the wait
        // below would time out, the epoch would be written, and the rescue would land after it.
        // Then wait for the aborted turn to unwind: its `finally` rescue appends the question +
        // partial reply, and those rows must land BEFORE the epoch or they stay in model history.
        denyFor(id)
        await abortActiveAndWait(id)
        try {
          await clearConversationContext(id)
          const [row] = await useDb().select({ at: conversations.contextEpochAt }).from(conversations).where(eq(conversations.id, id)).limit(1)
          peer.send(JSON.stringify({ type: 'cleared', epochAt: row?.at ? row.at.toISOString() : null }))
        } catch (err) {
          console.error('[agent] clear failed:', err)
          peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'failed to clear conversation' }))
        }
        return
      }
      default: return
    }
  },
  close(peer) {
    const s = conns.get(peer); if (!s) return
    // Unsubscribe only — the runs this socket started keep going and persist.
    s.unsubscribe?.()
    for (const id of s.runs) unregisterApprovalChannel(id)
    for (const id of denyPendingApprovals(s.pendingApprovals)) {
      // The socket is closing (or already closed) — sending is best-effort.
      try { peer.send(JSON.stringify({ type: 'approval-resolved', requestId: id })) } catch { /* closing */ }
    }
    conns.delete(peer)
  }
})
