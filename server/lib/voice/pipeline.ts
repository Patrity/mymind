// server/lib/voice/pipeline.ts
// Pipelines per-segment TTS synthesis: segments are pushed in reading order and their
// audio reaches the client in that same order — scrambled segment order would scramble
// the sentence.
//
// Before this existed, orchestrator.ts did `for (const chunk of ...) await speak(chunk)`
// — fully sequential, so each segment's synthesis (network round trip included) had to
// finish before the next one even started.
//
// Breeze is single-request (it 409s a second concurrent inference), so segments are
// strictly SERIAL now: concurrency is pinned to 1 and the constructor rejects anything
// else. What buys back the latency is that emission happens INSIDE `start()`, chunk by
// chunk as the engine produces them, rather than collecting a whole segment first. At
// ~1.9x realtime generation, buffering a segment cost roughly half its own duration in
// dead air before a single sample played; streaming makes time-to-first-audio ~6ms.
import type { TtsProvider } from './providers/types'
import type { SpeakChunk } from './speak'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

export interface SpeechPipelineDeps {
  synthesize: TtsProvider['synthesize']
  preset: VoicePresetDTO
  /** Reference clip bytes for a clone/direction preset; null for design/plain. */
  refAudio?: Uint8Array | null
  /** Resolves what a given segment should be spoken with. Returning a different preset and
   *  reference per segment is how the voice chain keeps ONE speaker for the turn: segment
   *  one renders normally and later segments are anchored to its own audio. Omitted in
   *  tests and for unchained turns, where every segment uses `preset`/`refAudio` as-is. */
  resolveVoice?: (segmentIndex: number) => { preset: VoicePresetDTO; refAudio: Uint8Array | null }
  signal: AbortSignal
  /** Max simultaneous in-flight syntheses. Must be 1 — see the constructor. */
  concurrency?: number
  /** Fired once per segment, right before its synthesis starts (mirrors the old
   *  per-chunk `state: 'speaking'` emit). Optional so tests can omit it. */
  onSpeaking?: () => void
  /** Fired once per audio chunk, as it arrives, strictly in segment order. `segmentText` is
   *  the text THIS chunk is audio for — passed through rather than tracked by the caller,
   *  because synthesis is async: a shared "current segment" variable has already moved on to
   *  the next segment by the time these chunks arrive. */
  onChunk: (c: SpeakChunk, segmentText: string) => void
  /** Fired once per segment, after its last chunk has been emitted (or it was dropped). */
  onSegmentEnd?: () => void
}

// Nothing is returned per segment any more: chunks are emitted as they arrive, so
// collecting them would hold a whole segment's PCM (~1 MB) alive for no reader.
type SegmentResult = void

/**
 * Preserves the sequential path's behaviour on top of pipelining:
 *  - `signal.aborted` is checked before starting a segment and before emitting each
 *    audio chunk, so an aborted turn stops cleanly and emits nothing further.
 *  - AbortError from a segment's synthesis is swallowed, same as before.
 *  - Unlike before, a NON-abort error is now also swallowed (not rethrown): the
 *    segment is dropped and the rest of the turn keeps playing, rather than one
 *    failed segment silently killing the whole turn.
 */
export class SpeechPipeline {
  private readonly concurrency: number
  private queue: Promise<SegmentResult>[] = []
  /** How many segments have been STARTED — the index handed to resolveVoice. */
  private started = 0

  constructor(private deps: SpeechPipelineDeps) {
    this.concurrency = deps.concurrency ?? 1
    // Emission happens inside start() now, so >1 in flight would interleave two segments'
    // audio. Breeze is single-request anyway; this makes the coupling explicit rather than
    // leaving a latent reordering bug for whoever raises the tuning constant.
    if (this.concurrency !== 1) throw new Error('SpeechPipeline: Breeze is single-request; concurrency must be 1')
  }

  /**
   * Start synthesizing `text`. Returns once the segment is enqueued (which, at the
   * pinned concurrency of 1, means once the previous segment has finished).
   */
  async push(text: string): Promise<void> {
    if (this.deps.signal.aborted) return
    if (this.queue.length >= this.concurrency) await this.drainOne()
    if (this.deps.signal.aborted) return
    this.queue.push(this.start(text))
  }

  /** Await every still-in-flight segment, in order. Call once at end of turn. */
  async drain(): Promise<void> {
    while (this.queue.length) await this.drainOne()
  }

  private start(text: string): Promise<SegmentResult> {
    this.deps.onSpeaking?.()
    const index = this.started++
    // Resolved per segment, not once per turn: after segment one has been spoken, the chain
    // has a recording of the voice, and every later segment is anchored to it.
    const voice = this.deps.resolveVoice?.(index)
      ?? { preset: this.deps.preset, refAudio: this.deps.refAudio ?? null }
    const run = async (): Promise<void> => {
      try {
        for await (const c of this.deps.synthesize(text, {
          preset: voice.preset, refAudio: voice.refAudio, signal: this.deps.signal
        })) {
          // Concurrency is pinned to 1 for Breeze, so the oldest in-flight segment IS the
          // one being drained — emit immediately rather than collecting. With concurrency
          // > 1 this would scramble segment order; see the cap in tuning.ts.
          if (!this.deps.signal.aborted) this.deps.onChunk(c, text)
        }
      } finally {
        // Fires whether the segment completed, threw, or was aborted — the closing
        // audio-end frame must bracket a dropped segment too.
        this.deps.onSegmentEnd?.()
      }
    }
    // Attach the handler synchronously (not inside drainOne, which may run much
    // later) so a segment that rejects before its turn to drain is never reported as
    // an unhandled promise rejection.
    return run().catch((err: unknown) => {
      // Swallowed, not rethrown: the segment is dropped and the rest of the turn plays on.
      if ((err as Error)?.name !== 'AbortError') {
        console.error('[voice] segment synthesis failed, dropping segment:', err)
      }
    })
  }

  private async drainOne(): Promise<void> {
    const p = this.queue.shift()
    if (!p) return
    await p
  }
}
