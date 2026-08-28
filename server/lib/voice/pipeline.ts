// server/lib/voice/pipeline.ts
// Pipelines per-segment TTS synthesis: up to `concurrency` segments are IN FLIGHT
// (network round-trip and all) at once, but their resulting audio is always emitted
// in the order the segments were pushed — never out of order, since scrambled
// segment order would scramble the sentence. Only the *starting* of synthesis is
// concurrent; emission is a strict, serial drain of an ordered queue.
//
// Before this existed, orchestrator.ts did `for (const chunk of ...) await speak(chunk)`
// — fully sequential, so each segment's synthesis (network round trip included) had to
// finish before the next one even started. With a slow expressive TTS engine, those
// gaps compound across a whole reply.
//
// The FIRST segment is a special case — see FIRST_SEGMENT_CONCURRENCY below.
import type { TtsProvider } from './providers/types'

/**
 * The very first segment of a turn is always synthesized ALONE, with nothing else in
 * flight — NOT the general `concurrency` cap. This looks like an off-by-one bug if you
 * don't know why: some of the TTS backends behind this app (Orpheus, via llama.cpp
 * `--parallel 3`) genuinely serve concurrent requests, but every slot shares ONE GPU,
 * so concurrent requests slow each other down. Measured on the rig: firing 3 chunks at
 * once makes all 3 finish together at ~10s — worse time-to-first-audio than firing
 * chunk 1 alone (~2.9s), because chunk 1 now pays a concurrency tax it doesn't need to.
 * Perceived responsiveness is governed entirely by chunk 1's latency, so chunk 1 must
 * never share a slot; only once it has been dispatched to the client is there anything
 * to gain from overlapping the rest.
 */
const FIRST_SEGMENT_CONCURRENCY = 1

export interface SpeechPipelineDeps {
  synthesize: TtsProvider['synthesize']
  voice: string
  provider?: string | null
  signal: AbortSignal
  /** Max simultaneous in-flight syntheses. Default 3. */
  concurrency?: number
  /** Fired once per segment, right before its synthesis starts (mirrors the old
   *  per-chunk `state: 'speaking'` emit). Optional so tests can omit it. */
  onSpeaking?: () => void
  /** Fired once per audio chunk, strictly in segment order. */
  onAudio: (bytes: Uint8Array) => void
}

type SegmentResult = Uint8Array[] | undefined // undefined = dropped (aborted or errored)

/**
 * Preserves the sequential path's behaviour on top of pipelining:
 *  - `signal.aborted` is checked before starting a segment and before emitting each
 *    audio chunk, so an aborted turn stops cleanly and emits nothing further.
 *  - AbortError from a segment's synthesis is swallowed, same as before.
 *  - Unlike before, a NON-abort error is now also swallowed (not rethrown): the
 *    segment is dropped and the rest of the turn keeps playing, rather than an
 *    exhausted-failover error on one segment silently killing the whole turn.
 */
export class SpeechPipeline {
  private readonly concurrency: number
  private queue: Promise<SegmentResult>[] = []
  // Flips true the moment the first segment has been drained (emitted, dropped, or
  // aborted — whatever the outcome, the depth-1 phase is over). Until then, `push`
  // enforces FIRST_SEGMENT_CONCURRENCY instead of `concurrency` — see the module doc.
  private firstSegmentDrained = false

  constructor(private deps: SpeechPipelineDeps) {
    this.concurrency = deps.concurrency ?? 3
  }

  private get effectiveConcurrency(): number {
    return this.firstSegmentDrained ? this.concurrency : FIRST_SEGMENT_CONCURRENCY
  }

  /**
   * Start synthesizing `text`. Returns once the segment is enqueued (which may
   * require first draining — and emitting — the oldest in-flight segment if the
   * current concurrency cap is already full; see `effectiveConcurrency`).
   */
  async push(text: string): Promise<void> {
    if (this.deps.signal.aborted) return
    if (this.queue.length >= this.effectiveConcurrency) await this.drainOne()
    if (this.deps.signal.aborted) return
    this.queue.push(this.start(text))
  }

  /** Await and emit every still-in-flight segment, in order. Call once at end of turn. */
  async drain(): Promise<void> {
    while (this.queue.length) await this.drainOne()
  }

  private start(text: string): Promise<SegmentResult> {
    this.deps.onSpeaking?.()
    const run = async (): Promise<Uint8Array[]> => {
      const out: Uint8Array[] = []
      for await (const bytes of this.deps.synthesize(text, { voice: this.deps.voice, provider: this.deps.provider, signal: this.deps.signal })) {
        out.push(bytes)
      }
      return out
    }
    // Attach the handler synchronously (not inside drainOne, which may run much
    // later) so a segment that rejects before its turn to drain is never reported as
    // an unhandled promise rejection.
    return run().catch((err: unknown) => {
      if ((err as Error)?.name !== 'AbortError') {
        console.error('[voice] segment synthesis failed, dropping segment:', err)
      }
      return undefined
    })
  }

  private async drainOne(): Promise<void> {
    const p = this.queue.shift()
    if (!p) return
    const bytesList = await p
    this.firstSegmentDrained = true // depth-1 phase ends here, win or lose (see module doc)
    if (!bytesList || this.deps.signal.aborted) return
    for (const bytes of bytesList) {
      if (this.deps.signal.aborted) return
      this.deps.onAudio(bytes)
    }
  }
}
