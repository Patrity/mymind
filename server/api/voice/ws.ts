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
import { legacyHooks } from '../../lib/voice/ws-legacy'
import { runtimeEnabled } from '../../lib/agent/runtime/flag'
import { enqueue, abortActive } from '../../lib/agent/runtime/queue'
import { hub, type Sink } from '../../lib/agent/runtime/stream'
import { registerApprovalChannel, unregisterApprovalChannel, turnStreamFor } from '../../lib/agent/runtime/approvals'
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
//   voice turn) | text JSON {type:'interrupt'} (abort the thread's running turn — the ONLY
//   abort; closing the tab, `load` and `new` never abort) |
//   {type:'preset',presetId} (voice pick; null/absent = the default preset) |
//   {type:'model',modelDefId} (ephemeral reasoning-model override; null clears) |
//   {type:'text',text,speak?,skill?} (typed turn; `skill` names a `skill`-kind `/`-command the
//   composer resolved to — see assembleContext's `skill` input. Sent while a turn is running on
//   the thread, it is STEERED into that turn instead of queuing a new one) |
//   {type:'load',conversationId} (view an existing thread: subscribe to its live frames; does
//   NOT abort anything and does NOT replay) |
//   {type:'attach'} (replay the viewed thread's running turn so far — sent after `load` when the
//   thread has a turn in flight, so a reload / second tab picks the stream up mid-turn) |
//   {type:'new'} (stop viewing; the next text starts a new thread. Does NOT abort) |
//   {type:'clear'} (forget this conversation's transcript — writes an epoch, deletes
//   nothing; a no-op if there is no conversation yet; aborts the thread's running turn) |
//   {type:'approve'|'deny',requestId,...} (resolve a pending exec approval)
// Server→client: binary = raw PCM (s16le mono) for the segment currently open — only to the
//   socket that originated the turn |
//   text JSON = {type:'audio-begin',turnId,segmentId,sampleRate} / {type:'audio-end',segmentId}
//   (bracket each spoken segment; originating socket only) | {type:'state',state} |
//   {type:'chunk',turnId,chunk} (an AI SDK UIMessageChunk for the turn's assistant message) |
//   {type:'user-message',turnId,message} (the turn's user message, once, before its chunks) |
//   {type:'steered',text} (this socket's text was spliced into the running turn, not queued) |
//   {type:'approval'|'approval-resolved',...} (exec approval lifecycle) |
//   {type:'conversation',conversationId,title} (emitted once, when the first turn of a new thread persists) |
//   {type:'persisted',conversationId} (the turn's rows are committed — arms the page's re-read) |
//   {type:'cleared',epochAt} (the /clear boundary; the UI anchors a divider here — epochAt is
//   null when there was nothing to clear, which the UI reads as "no-op", not a failure) |
//   {type:'error',message} (turn failure; always followed by {type:'state',state:'idle'}).
interface ConnState {
  sink: Sink
  /** Voice preset the client picked (cookie-backed); null = fall back to the default row. */
  presetId: string | null
  model: string | null
  /** The thread this socket is viewing; null = the next message starts a new side thread. */
  conversationId: string | null
  unsubscribe: (() => void) | null
  /** Runs this socket originated — their approval channels are dropped on close. */
  runs: Set<string>
  pendingApprovals: Map<string, { resolve: (d: { approved: boolean }) => void; timer: ReturnType<typeof setTimeout>; req: ApprovalRequest }>
}
const conns = new WeakMap<object, ConnState>()

// STT resolved from the registry at call time, with per-usage failover. (TTS moved to the
// runner, which speaks only while the originating socket is still attached.)
const stt: SttProvider = { transcribe: (audio, opts) => withFailover('stt', m => sttFromModel(m).transcribe(audio, opts)) }

function view(s: ConnState, conversationId: string | null, replay: boolean) {
  s.unsubscribe?.(); s.unsubscribe = null
  s.conversationId = conversationId
  if (conversationId) s.unsubscribe = hub.subscribe(conversationId, s.sink, { replay })
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
    if (!runtimeEnabled()) return legacyHooks.open(peer)
    conns.set(peer, {
      sink: { id: randomUUID(), send: d => peer.send(d) },
      presetId: null, model: null, conversationId: null, unsubscribe: null, runs: new Set(), pendingApprovals: new Map()
    })
  },
  async message(peer, message) {
    if (!runtimeEnabled()) return legacyHooks.message(peer, message)
    const s = conns.get(peer); if (!s) return
    // Classify by CONTENT, not transport type: crossws@0.3.5's node adapter drops
    // the isBinary flag, so JSON control frames arrive as Buffers (see frames.ts).
    const frame = classifyFrame(typeof message.rawData === 'string' ? message.rawData : message.uint8Array())
    if (frame.kind === 'ignore') return

    // Interactive approval prompt for one run this socket originated. The persisted allowlist
    // is checked BEFORE this, in runtime/approvals.ts's approvalFor, so it applies even after
    // this socket is gone; only a command that needs Tony reaches here. Emit an approval
    // request to the peer and await Tony's decision (120s auto-deny).
    const requestApproval = (runId: string) => async (req: ApprovalRequest): Promise<{ approved: boolean }> => {
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
        if (req.callId) turnStreamFor(runId)?.emit({ type: 'approval-request', approvalId: requestId, callId: req.callId, name: req.tool })
      })
    }
    // Deny every pending approval and tell the client each request is resolved — used
    // whenever the turn that asked for them is abandoned (interrupt / clear / socket close)
    // so a tool never waits out its 120s timeout on a question nobody can see.
    const denyAll = () => { for (const id of denyPendingApprovals(s.pendingApprovals)) peer.send(JSON.stringify({ type: 'approval-resolved', requestId: id })) }

    const submit = async (text: string, o: { speak: boolean; skill?: string; attachments: AttachmentRef[]; modality: 'text' | 'voice' }) => {
      try {
        const r = await enqueue({
          sessionKey: s.conversationId ? `thread:${s.conversationId}` : 'thread:new',
          trigger: 'user', profile: 'interactive', modelDefId: s.model, originSinkId: s.sink.id,
          input: { text, modality: o.modality, speak: o.speak, skill: o.skill, attachments: o.attachments, presetId: s.presetId }
        })
        if (r.conversationId !== s.conversationId) view(s, r.conversationId, true)
        if (r.steered) { peer.send(JSON.stringify({ type: 'steered', text })); return }
        s.runs.add(r.runId)
        registerApprovalChannel(r.runId, requestApproval(r.runId))
      } catch (err) {
        peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'could not start the turn' }))
        peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
      }
    }

    if (frame.kind !== 'control') {
      // Voice: transcribe HERE, then it is an ordinary run. STT used to happen inside the turn,
      // under the lock; now the run only ever sees text. Voice always speaks (as legacy did).
      try {
        peer.send(JSON.stringify({ type: 'state', state: 'thinking' }))
        const text = (await stt.transcribe(frame.bytes, { language: VOICE_TUNING.stt.language })).trim()
        if (!text) { peer.send(JSON.stringify({ type: 'state', state: 'idle' })); return }
        await submit(text, { speak: true, attachments: [], modality: 'voice' })
      } catch (err) {
        peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'transcription failed' }))
        peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
      }
      return
    }

    const a = routeFrame(frame.msg)
    switch (a.kind) {
      case 'abort': if (s.conversationId) await abortActive(s.conversationId); denyAll(); return
      case 'preset': s.presetId = a.presetId; return
      case 'model': s.model = a.modelDefId; return
      // load / new only change what this socket VIEWS. The thread's running turn (if any)
      // keeps going and persists; `attach` replays it for a viewer that wants it.
      case 'load': view(s, a.conversationId, false); return
      case 'attach': if (s.conversationId) hub.replay(s.conversationId, s.sink); return
      case 'new': view(s, null, false); return
      case 'text': await submit(a.text, { speak: a.speak, skill: a.skill, attachments: a.attachments, modality: 'text' }); return
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
        await abortActive(id); denyAll()
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
    if (!runtimeEnabled()) return legacyHooks.close(peer)
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
