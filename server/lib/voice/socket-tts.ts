// Cycle 81 (spec §4): TTS in the web process. Runs execute in apps/worker and stream TEXT over the
// bus; the voice socket that originated a spoken run (`speak` on) synthesizes it here, from the
// same text deltas it forwards to the browser, and sends `audio-begin` / PCM / `audio-end` to that
// socket only. Other sockets viewing the thread get the text, never audio — as before.
//
// The browser sees the frame order the in-process runner used to produce for its own socket:
//   - a spoken turn never sends `typing` to its origin socket — `speaking` arrives per segment;
//   - the run's `state: idle` and EVERYTHING after it (the finish chunks, `persisted`, the next
//     run's frames) wait until the turn's audio has played out of the pipeline — the old
//     orchestrator drained its speech pipeline before emitting idle;
//   - text no longer waits for speech: the worker generates at model speed, so the transcript can
//     run ahead of the voice (the one visible change, and the point of moving TTS out of the run).
// Stop / barge-in, `/clear`, leaving the thread and closing the socket abort the synthesis
// (abort()) — including a spoken run whose first frame has not arrived yet (its expectation is
// dropped) — and an `error` frame or an `abort`/`error` chunk of the run ends it. A frame at or
// below the last seq already handled for its run (a replay after re-viewing the thread) is
// forwarded but never spoken twice. Approval frames never wait behind audio (a chat approval
// auto-denies at 120s).
import type { HubFrame } from '@mymind/core/lib/bus/events'
import { createTurnSpeaker, type SpeakerEvent, type TurnSpeaker } from '@mymind/core/lib/voice/turn-speaker'
import type { TtsProvider } from '@mymind/core/lib/voice/providers/types'
import type { VoicePresetDTO } from '@mymind/core/shared/types/voice-presets'

export interface FrameMeta { runId: string; seq?: number }

export interface SocketTtsDeps {
  /** One JSON frame to the socket, for `conversationId` (the caller tags it with its cid, and a
   *  run frame with its run + seq). */
  send(conversationId: string, frame: object, meta?: FrameMeta): void
  sendBinary(bytes: Uint8Array): void
  /** The run's voice, resolved at turn start as before (never throws — see resolveTurnVoice). */
  resolveVoice(presetId: string | null): Promise<{ preset: VoicePresetDTO; refAudio: Uint8Array | null }>
  synthesize: TtsProvider['synthesize']
  /** The longest frames wait behind a turn's audio before it is cut off (default 120s). */
  holdTimeoutMs?: number
}

export interface SocketTts {
  /** This socket originated `runId` with `speak` on: speak it when its frames arrive. */
  expect(runId: string, o: { presetId: string | null; conversationId: string }): void
  /** A run frame for this socket (from the relay), in stream order. */
  frame(conversationId: string, frame: HubFrame, meta: FrameMeta): void
  /** Stop speaking (one conversation's runs, or all) and release any frames held behind audio. */
  abort(conversationId?: string): void
}

interface Session {
  runId: string
  conversationId: string
  ac: AbortController
  turnId: number | null
  speaker: Promise<TurnSpeaker | null>
  chain: Promise<void>
  /** Highest seq of this run already handled — a replayed frame at or below it is not spoken. */
  lastSeq: number
}
interface Held { conversationId: string; frame: HubFrame; meta: FrameMeta }
const NEVER_HELD = new Set(['approval', 'approval-resolved'])

const EXPECT_CAP = 64
const HOLD_TIMEOUT_MS = 120_000

export function createSocketTts(deps: SocketTtsDeps): SocketTts {
  const expected = new Map<string, { presetId: string | null; conversationId: string }>()
  const sessions = new Map<string, Session>()
  // Frames waiting for a finished turn's audio to play out; null = nothing is waiting.
  let held: Held[] | null = null
  let holding: Session | null = null
  let holdGen = 0

  const onSpeaker = (s: Session) => (e: SpeakerEvent) => {
    if (s.ac.signal.aborted) return
    switch (e.type) {
      case 'speaking': deps.send(s.conversationId, { type: 'state', state: 'speaking' }); return
      case 'audio-begin': deps.send(s.conversationId, { type: 'audio-begin', segmentId: e.segmentId, sampleRate: e.sampleRate, turnId: s.turnId ?? undefined }); return
      case 'audio': deps.sendBinary(e.bytes); return
      case 'audio-end': deps.send(s.conversationId, { type: 'audio-end', segmentId: e.segmentId })
    }
  }

  const open = (runId: string, conversationId: string, presetId: string | null): Session => {
    const ac = new AbortController()
    const s: Session = { runId, conversationId, ac, turnId: null, speaker: Promise.resolve(null), chain: Promise.resolve(), lastSeq: 0 }
    s.speaker = deps.resolveVoice(presetId)
      .then(v => createTurnSpeaker({ synthesize: deps.synthesize, preset: v.preset, refAudio: v.refAudio, signal: ac.signal, emit: onSpeaker(s) }))
      .catch((err: unknown) => { console.error('[voice] resolving the turn voice failed:', err); return null })
    sessions.set(runId, s)
    return s
  }
  const after = (s: Session, step: (sp: TurnSpeaker) => Promise<void>) => {
    s.chain = s.chain.then(async () => {
      const sp = await s.speaker
      if (sp && !s.ac.signal.aborted) await step(sp)
    }).catch((err: unknown) => console.error('[voice] speaking a turn failed:', err))
    return s.chain
  }
  const end = (s: Session) => {
    s.ac.abort()
    if (sessions.get(s.runId) === s) sessions.delete(s.runId)
  }

  const release = () => {
    const out = held ?? []
    held = null
    holding = null
    holdGen++
    // Back through frame(): a later spoken run among them starts (and may hold) in order.
    for (const h of out) api.frame(h.conversationId, h.frame, h.meta)
  }

  const hold = (s: Session, h: Held) => {
    sessions.delete(s.runId) // nothing after idle is spoken (e.g. the image-embed append)
    held = [h]
    holding = s
    const gen = ++holdGen
    const timeout = deps.holdTimeoutMs ?? HOLD_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<void>((r) => { timer = setTimeout(() => { s.ac.abort(); r() }, timeout) })
    void Promise.race([after(s, sp => sp.finish()), timedOut]).then(() => {
      clearTimeout(timer)
      if (gen === holdGen) release()
    })
  }

  const api: SocketTts = {
    expect(runId, o) {
      expected.set(runId, o)
      if (expected.size > EXPECT_CAP) expected.delete(expected.keys().next().value!)
    },

    frame(conversationId, f, meta) {
      if (held) {
        if (NEVER_HELD.has(f.type)) { deps.send(conversationId, f, meta); return }
        held.push({ conversationId, frame: f, meta })
        return
      }
      let s = sessions.get(meta.runId)
      if (!s) {
        const exp = expected.get(meta.runId)
        if (exp) { expected.delete(meta.runId); s = open(meta.runId, conversationId, exp.presetId) }
      }
      if (!s) { deps.send(conversationId, f, meta); return }
      if (s.turnId === null && 'turnId' in f && typeof f.turnId === 'number') s.turnId = f.turnId
      if (f.type === 'state' && f.state === 'typing') return
      // Already handled (a replay after this socket re-viewed the thread): forward, never re-speak.
      if (meta.seq !== undefined && meta.seq <= s.lastSeq) { deps.send(conversationId, f, meta); return }
      if (meta.seq !== undefined) s.lastSeq = meta.seq
      if (f.type === 'state' && f.state === 'idle') { hold(s, { conversationId, frame: f, meta }); return }
      if (f.type === 'error' || (f.type === 'chunk' && (f.chunk.type === 'abort' || f.chunk.type === 'error'))) end(s)
      deps.send(conversationId, f, meta)
      if (f.type === 'chunk' && f.chunk.type === 'text-delta') {
        const text = f.chunk.delta
        const sess = s
        void after(sess, sp => sp.push(text))
      }
    },

    abort(conversationId) {
      // A spoken run whose first frame has not arrived yet is stopped too (review I1).
      for (const [runId, e] of [...expected]) if (!conversationId || e.conversationId === conversationId) expected.delete(runId)
      for (const s of [...sessions.values()]) if (!conversationId || s.conversationId === conversationId) end(s)
      if (holding && (!conversationId || holding.conversationId === conversationId)) {
        holding.ac.abort()
        release()
      }
    }
  }
  return api
}
