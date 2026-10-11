// server/api/voice/ws.ts
// Thin socket: auth, STT, TTS, voice/model choice, approvals UI, and frame routing. Turns do NOT
// live here — they are runs executed by apps/worker (cycle 81), which outlive this socket and this
// process. Their frames arrive over the Postgres bus (lib/bus/relay.ts); a spoken run this socket
// originated is synthesized HERE (server/lib/voice/socket-tts.ts).
// Closing the tab unsubscribes; it never aborts. Stop ('interrupt') is the only abort.
import { randomUUID } from 'node:crypto'
import { classifyFrame } from '../../lib/voice/frames'
import { sttFromModel } from '@mymind/core/lib/voice/providers'
import type { SttProvider } from '@mymind/core/lib/voice/providers/types'
import { withFailover } from '@mymind/core/lib/ai/registry/resolve'
import { VOICE_TUNING } from '@mymind/core/lib/voice/tuning'
import { routeFrame } from '../../lib/voice/ws-routing'
import { enqueue } from '@mymind/core/lib/agent/runtime/queue'
import { sendCommand, CommandTimeoutError, STOP_ABORT_TTL_MS } from '@mymind/core/lib/bus/commands'
import { withCid, type Sink } from '@mymind/core/lib/agent/runtime/stream'
import { runEventRelay } from '@mymind/core/lib/bus/relay'
import { clientApprovalFrame, openApprovalFrames, type HubFrame } from '@mymind/core/lib/bus/events'
import { resolveTurnVoice } from '@mymind/core/services/voice-presets'
import { speakWithPreset } from '@mymind/core/lib/voice/speak'
import { createSocketTts, type SocketTts } from '../../lib/voice/socket-tts'
import { clearConversationContext } from '../../services/conversation-clear'
import { useDb } from '@mymind/core/db'
import { conversations } from '@mymind/core/db/schema'
import { eq } from 'drizzle-orm'
import type { AttachmentRef } from '@mymind/core/lib/agent/attachments'

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
//   {type:'attach',after:{[runId]:seq}} (a RECONNECT: resume each named run just past the last seq
//   the client rendered, even if it has finished since — cycle 81) |
//   {type:'new'} (stop viewing; the next text starts a new thread. Does NOT abort) |
//   {type:'clear'} (forget this conversation's transcript — writes an epoch, deletes
//   nothing; a no-op if there is no conversation yet; aborts the thread's running turn in the
//   worker and waits for its `settled` answer first, so its rescued rows land before the epoch —
//   on no answer within 10s, or settled:false, it reports an error and clears NOTHING) |
//   {type:'approve'|'deny',requestId,...} (answer a card this socket was shown: forwarded to the
//   worker as an `approval-decision` command — the run that asked decides it, cycle 81 §3.4)
// Server→client: binary = raw PCM (s16le mono) for the segment currently open — only to the
//   socket that originated the turn |
//   text JSON = {type:'audio-begin',turnId,segmentId,sampleRate} / {type:'audio-end',segmentId}
//   (bracket each spoken segment; originating socket only) | {type:'state',state} |
//   {type:'chunk',turnId,chunk} (an AI SDK UIMessageChunk for the turn's assistant message) |
//   every frame of a RUN (chunk/user-message/state/conversation/persisted/error from the bus) also
//   carries `run` + `seq` — what the client hands back in `attach.after` on a reconnect |
//   {type:'user-message',turnId,message} (the turn's user message, once, before its chunks) |
//   {type:'steered',text,cid} (this socket's text was spliced into the running turn, not queued;
//   `cid` names the thread and the client's cid guard gates it; for a voice utterance it is
//   followed by {type:'state',state:'idle'}) |
//   {type:'queued',text,cid} (this socket's text became its own run QUEUED behind the thread's
//   running run — a headless wake, typically — so the client paints its bubble now; `cid` names
//   the thread, and the client's cid guard gates it like any conversation-scoped frame. Followed
//   by {type:'state',state:'idle'} for a voice utterance, same as `steered`) |
//   {type:'approval'|'approval-resolved',...} (approval card lifecycle — published by the worker's
//   run on the bus to every socket viewing the thread; see runtime/bus-approvals.ts) |
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
  /** Cards this socket has been SHOWN and that are still open (requestId → its thread and run),
   *  from the bus's approval / approval-resolved frames and the re-send on attach. Only these are
   *  forwarded as decisions: a socket can answer what it was asked, never a requestId it merely
   *  names. Pruned when the socket leaves the thread and when the run's turn ends. */
  cards: Map<string, { cid: string; runId: string }>
  /** Speaks this socket's spoken runs from their streamed text (cycle 81, spec §4). */
  tts: SocketTts
}
const conns = new WeakMap<object, ConnState>()

// STT resolved from the registry at call time, with per-usage failover. TTS is per socket (s.tts):
// only the socket that originated a spoken run speaks it, and only while it is attached.
const stt: SttProvider = { transcribe: (audio, opts) => withFailover('stt', m => sttFromModel(m).transcribe(audio, opts)) }

/** What a bus frame looks like on the browser's socket: unchanged, except `approval`, which
 *  carries the full ApprovalRequest on the bus and only the card's fields here. */
function toClient(f: HubFrame): object {
  return f.type === 'approval' ? clientApprovalFrame(f) : f
}

/** Keep `s.cards` in step with what this socket was shown (approval in, approval-resolved out, and
 *  a run's end — `persisted`/`error` — closes whatever it left open, e.g. after a worker crash). */
function trackCards(s: ConnState, cid: string, f: HubFrame, runId: string | undefined) {
  if (f.type === 'approval' && runId) s.cards.set(f.requestId, { cid, runId })
  else if (f.type === 'approval-resolved') s.cards.delete(f.requestId)
  else if ((f.type === 'persisted' || f.type === 'error') && runId) {
    for (const [id, c] of s.cards) if (c.runId === runId) s.cards.delete(id)
  }
}

/** Re-send the thread's still-open cards to this socket (fix round 1, I1). A reconnect resumes PAST
 *  the card's seq (`attach.after`), so the relay alone would never show it again while the worker's
 *  run waits on it. Sent with no run/seq (a re-send must not move the client's resume cursor);
 *  duplicates of a card the replay also delivers are idempotent client-side (keyed by requestId). */
async function resendOpenCards(s: ConnState, cid: string) {
  try {
    const open = await openApprovalFrames(cid)
    if (s.conversationId !== cid) return // left the thread meanwhile
    for (const o of open) {
      s.cards.set(o.frame.requestId, { cid, runId: o.runId })
      withCid(cid, s.sink).send(JSON.stringify(o.frame))
    }
  } catch (err) {
    console.error('[agent] re-sending open approval cards failed:', err)
  }
}

function select(s: ConnState, conversationId: string | null) {
  // Leaving a thread silences its audio (the old hub stopped delivering it to a socket that left).
  if (s.conversationId && s.conversationId !== conversationId) {
    s.tts.abort(s.conversationId)
    // Its cards can't be answered from here any more (M1): this socket stops hearing their outcome.
    for (const [id, c] of s.cards) if (c.cid === s.conversationId) s.cards.delete(id)
  }
  s.unsubscribe?.(); s.unsubscribe = null
  s.conversationId = conversationId
  s.viewSeq++
}
/** Select AND subscribe, replaying the running turn so far — the relay runs the replay and the
 *  live reads on one serial chain per thread, so no live frame can arrive before the replay and no
 *  frame twice. Frames go out through a `withCid`-wrapped sink (tags every chunk/user-message/
 *  audio-begin frame with `conversationId`) — belt and braces for the client's own turn-id
 *  tracking; see stream.ts's `withCid` doc comment. */
function view(s: ConnState, conversationId: string | null, after?: Record<string, number>) {
  select(s, conversationId)
  if (conversationId) {
    s.unsubscribe = runEventRelay().subscribe(conversationId, {
      id: s.sink.id,
      deliver: (frame, meta) => {
        trackCards(s, conversationId, frame as HubFrame, meta?.runId)
        s.tts.frame(conversationId, frame, meta)
      }
    }, { replay: true, after })
    void resendOpenCards(s, conversationId)
  }
}

/** Stop/barge-in → the worker's `abort` command (spec §3.5). Fire-and-forget: Stop needs no answer
 *  (the run's own frames show it stopping); `abort` is urgent there, so it never waits behind the
 *  thread's other commands. Aborting the run also denies its open cards (bus-approvals.ts). It
 *  expires after STOP_ABORT_TTL_MS (M4): a worker that claims it after an outage ignores it rather
 *  than abort a turn started since. */
function abortInWorker(p: { runId?: string; conversationId?: string }) {
  sendCommand('abort', { ...p, expiresAt: Date.now() + STOP_ABORT_TTL_MS }).catch(err => console.error('[agent] sending abort to the worker failed:', err))
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
    const sink: Sink = { id: randomUUID(), send: d => peer.send(d) }
    conns.set(peer, {
      sink,
      presetId: null, model: null, conversationId: null, unsubscribe: null,
      viewSeq: 0, stopSeq: 0, submitLock: Promise.resolve(), lastRun: null,
      cards: new Map(),
      tts: createSocketTts({
        // Run frames carry `run`/`seq` (cycle 81): a client that reconnects — after a web restart,
        // a deploy — sends them back in `attach.after` and resumes just past what it rendered.
        send: (conversationId, frame, meta) => withCid(conversationId, sink).send(JSON.stringify(
          meta ? { run: meta.runId, seq: meta.seq, ...toClient(frame as HubFrame) } : toClient(frame as HubFrame))),
        sendBinary: bytes => sink.send(bytes),
        resolveVoice: presetId => resolveTurnVoice(presetId, true),
        synthesize: (text, o) => speakWithPreset(text, o.preset, 'agent', o.signal, o.refAudio ?? null)
      })
    })
  },
  async message(peer, message) {
    const s = conns.get(peer); if (!s) return
    // Classify by CONTENT, not transport type: crossws@0.3.5's node adapter drops
    // the isBinary flag, so JSON control frames arrive as Buffers (see frames.ts).
    const frame = classifyFrame(typeof message.rawData === 'string' ? message.rawData : message.uint8Array())
    if (frame.kind === 'ignore') return

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
            s.lastRun = { id: r.runId, conversationId: r.conversationId }
            // Spoken: this socket synthesizes the run's text as it streams in (spec §4). Registered
            // before this continuation yields, so it precedes the run's first frame.
            if (o.speak) s.tts.expect(r.runId, { presetId: s.presetId, conversationId: r.conversationId })
            // Stop landed while the enqueue was in flight (and the socket is still on this
            // thread): the run just created is what Stop meant. The worker's pre-abort covers a
            // run it has not claimed yet (it starts already aborted).
            if (s.stopSeq !== stopAt && stillViewing) abortInWorker({ runId: r.runId, conversationId: r.conversationId })
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
        // Barge-in / Stop silences this socket at once, whatever the run does next.
        s.tts.abort()
        // The viewed thread's running run, and this socket's last run on it even if still queued
        // (the worker skips a run that already finished). Runs of other threads are left alone —
        // and so are their cards: only an aborted run's cards are denied.
        const runId = s.lastRun && s.lastRun.conversationId === viewing ? s.lastRun.id : undefined
        if (viewing || runId) abortInWorker({ ...(runId ? { runId } : {}), ...(viewing ? { conversationId: viewing } : {}) })
        return
      }
      case 'preset': s.presetId = a.presetId; return
      case 'model': s.model = a.modelDefId; return
      // load / new only change what this socket VIEWS. The thread's running turn (if any)
      // keeps going and persists. `load` does not subscribe: `attach` (sent once the client has
      // committed the persisted transcript) subscribes + replays atomically, so a live chunk can
      // never arrive before the replay and then be duplicated by it.
      case 'load': select(s, a.conversationId); return
      case 'attach': if (s.conversationId) view(s, s.conversationId, a.after); return
      case 'new': select(s, null); return
      case 'text': await submit(a.text, { speak: a.speak, skill: a.skill, attachments: a.attachments, modality: 'text', conversationId: a.conversationId }); return
      // Approve/deny: forwarded to the worker, whose run holds the request (and decides "always
      // allow" from it — never from this frame). Only a card this socket was shown and that is still
      // open; `approval-decision` is urgent in the worker, so the awaiting tool unblocks at once.
      case 'approve': case 'deny': {
        const card = s.cards.get(a.requestId)
        if (!card) return
        try {
          const pending = await sendCommand('approval-decision', a.kind === 'approve'
            ? { requestId: a.requestId, approved: true, remember: a.remember, ...(a.pattern !== undefined ? { pattern: a.pattern } : {}) }
            : { requestId: a.requestId, approved: false }, { awaitResult: true })
          // Delivered (M2): only now is the card closed here. `false` = the worker no longer holds
          // it (decided elsewhere, timed out, its run died) — close the stale card on the page too.
          s.cards.delete(a.requestId)
          if (pending === false) withCid(card.cid, s.sink).send(JSON.stringify({ type: 'approval-resolved', requestId: a.requestId }))
        } catch (err) {
          // Not delivered: the card stays answerable here, and the user is told (M2).
          console.error('[agent] sending an approval decision to the worker failed:', err)
          peer.send(JSON.stringify({ type: 'error', message: 'Could not reach the agent worker — your answer was not delivered. Try again.' }))
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
        // Abort the thread's running turn IN THE WORKER and wait for its answer: the aborted turn's
        // `finally` rescue appends the question + partial reply, and those rows must land BEFORE
        // the epoch or they stay in model history (spec §3.5). The abort also denies the run's
        // open cards (bus-approvals.ts races the abort signal), so a run parked on one unwinds.
        // No answer within 10s, or settled:false (it did not unwind in time) → an error and NO
        // epoch: clearing anyway would let the rescue land after it.
        s.tts.abort(id)
        let settled = false
        try {
          settled = (await sendCommand('abort', { conversationId: id }, { awaitResult: true }))?.settled === true
        } catch (err) {
          console.error('[agent] clear: abort in the worker failed:', err)
          peer.send(JSON.stringify({
            type: 'error',
            message: err instanceof CommandTimeoutError
              ? 'Could not clear: the agent worker did not confirm the running turn stopped. Try again in a moment.'
              : 'Could not clear: stopping the running turn failed. Try again in a moment.'
          }))
          return
        }
        if (!settled) {
          peer.send(JSON.stringify({ type: 'error', message: 'Could not clear: the running turn has not stopped yet. Try again in a moment.' }))
          return
        }
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
    s.tts.abort()
    // Open cards are NOT denied: they belong to the run in the worker, which other tabs on the
    // thread — or this page once it reconnects (every attach re-sends the thread's open cards,
    // resendOpenCards) — can still answer, and which auto-denies at 120s.
    conns.delete(peer)
  }
})
