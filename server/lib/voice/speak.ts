// Composes: queue slot -> Breeze call -> preset field mapping. The ONLY place that may
// call breezeSpeak, because the queue slot must wrap the whole stream lifetime.
import { Buffer } from 'node:buffer'
import { breezeSpeak, BreezeError, busyBackoffMs, BUSY_RETRY_ATTEMPTS, type BreezeRequest, type BreezeStream } from './breeze'
import { breezeQueue, type BreezeQueue, type QueuePriority } from './breeze-queue'
import { resolveChain } from '../ai/registry/resolve'
import type { VoicePresetDTO, SpeakOverrides } from '../../../shared/types/voice-presets'

export type SpeakChunk =
  | { kind: 'begin'; sampleRate: number }
  | { kind: 'pcm'; bytes: Uint8Array }

export interface SpeakDeps {
  baseURL: () => Promise<string>
  queue?: BreezeQueue
  speakFn?: typeof breezeSpeak
  /** Injected so the busy-retry backoff is testable without real timers. */
  sleep?: (ms: number) => Promise<void>
  /** Fired before each busy wait, so a surface can say "the rig is busy" instead of failing. */
  onBusy?: (attempt: number) => void
}

/**
 * Merge ad-hoc parameters over a preset for a SINGLE synthesis. Returns a new object;
 * the input is never mutated and nothing is ever written to the database.
 *
 * This exists so that auditioning four seeds — or previewing an unsaved instruction — is
 * a preview rather than four writes to a live row. The previous shape PATCHed the row per
 * take and restored it in a `finally`, which meant a closed tab, a dropped connection or a
 * dead process left the preset stuck on an audition seed. The live agent resolves that
 * same row per turn, so it would then have spoken in it.
 *
 * An ALLOW-LIST, not a deny-list: anything not named here (maxSegmentChars, every
 * reference field, name, isDefault) is structurally unreachable from an override, so a
 * later addition to VoicePresetDTO cannot accidentally become overridable.
 *
 * Non-finite numbers are ignored rather than applied: a NaN seed reaches the rig as
 * `seed=NaN` and comes back as an opaque 500, whereas falling back to the preset's own
 * calibrated value is always safe.
 */
export function applyOverrides(preset: VoicePresetDTO, overrides?: SpeakOverrides | null): VoicePresetDTO {
  if (!overrides) return preset
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const merged: VoicePresetDTO = { ...preset }

  // '' and a blank string mean "no instruction", exactly as the column stores it — the
  // cfg pre-flight below tests `instruction?.trim()`, so normalising here keeps the
  // in-memory preset indistinguishable from a row that never had one.
  if (typeof overrides.instruction === 'string') merged.instruction = overrides.instruction.trim() || null
  else if (overrides.instruction === null) merged.instruction = null

  merged.seed = num(overrides.seed) ?? merged.seed
  merged.cfgScale = num(overrides.cfgScale) ?? merged.cfgScale
  merged.temperature = num(overrides.temperature) ?? merged.temperature
  merged.topP = num(overrides.topP) ?? merged.topP
  merged.topK = num(overrides.topK) ?? merged.topK

  return merged
}

export function presetToRequest(text: string, p: VoicePresetDTO, refAudio: Uint8Array | null): BreezeRequest {
  // A LOCKED preset is spoken as a pure clone: its description is already expressed in the
  // frozen clip, and re-applying it on top only pulls against the reference. Measured on
  // four segments of one reply, lower spread is more consistent:
  //
  //   design, no reference                    23.9 Hz   timbre 0.636
  //   locked clip, instruction re-applied     39.8 Hz   timbre 0.612
  //   locked clip, spoken as a pure clone     22.6 Hz   timbre 0.526
  //   a real recorded clip, pure clone         4.5 Hz   timbre 0.418
  //
  // An UPLOADED clip keeps its instruction: steering delivery is the reason someone writes
  // one against a voice they already chose.
  const pureClone = p.refSource === 'locked'
  return {
    text,
    instruction: pureClone ? null : p.instruction,
    // cfg above 1 needs an instruction, at the rig and in the DB CHECK alike.
    cfgScale: pureClone ? 1 : p.cfgScale,
    seed: p.seed,
    temperature: p.temperature,
    topP: p.topP,
    topK: p.topK,
    refAudio: refAudio ? { bytes: refAudio, filename: 'reference.wav' } : null,
    refText: p.refText
  }
}

/**
 * Dial the rig, treating 409 as "wait", not "fail".
 *
 * Our breezeQueue already serialises this process, so a 409 means something OUTSIDE it holds
 * the rig's slot: the interim Gradio UI, another client, or the rig still finishing a render
 * whose client walked away. All of those clear on their own — surfacing an error on the first
 * one would tell the user their voice is broken when it is merely occupied.
 */
async function dialWithBusyRetry(
  base: string,
  req: BreezeRequest,
  speakFn: typeof breezeSpeak,
  deps: SpeakDeps,
  signal?: AbortSignal
): Promise<BreezeStream> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  let lastBusy: BreezeError | null = null
  for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    try {
      return await speakFn(base, req)
    } catch (err) {
      if (!(err instanceof BreezeError) || err.code !== 'busy') throw err
      lastBusy = err
      deps.onBusy?.(attempt)
      await sleep(busyBackoffMs(attempt))
    }
  }
  throw lastBusy ?? new BreezeError('busy', 'Breeze stayed busy')
}

export function createSpeaker(deps: SpeakDeps) {
  const queue = deps.queue ?? breezeQueue
  const speakFn = deps.speakFn ?? breezeSpeak

  return async function* speak(
    text: string,
    preset: VoicePresetDTO,
    priority: QueuePriority,
    signal?: AbortSignal,
    refAudio: Uint8Array | null = null
  ): AsyncIterable<SpeakChunk> {
    // The signal guards the WAIT only. Aborting here is safe — no request exists yet, so
    // there is no rig generator to strand. It is deliberately not passed any further.
    const release = await queue.acquire(priority, signal)
    let stream: BreezeStream | null = null
    try {
      const base = await deps.baseURL()
      stream = await dialWithBusyRetry(base, presetToRequest(text, preset, refAudio), speakFn, deps, signal)
      yield { kind: 'begin', sampleRate: stream.sampleRate }
      for await (const bytes of stream.chunks) {
        // Checked here rather than by aborting the fetch: a cancelled render stops being
        // DELIVERED immediately, while its body keeps draining in the background so the rig
        // can finish and release its own lock.
        if (signal?.aborted) break
        yield { kind: 'pcm', bytes }
      }
    } finally {
      // Runs on normal completion, on throw, AND when the consumer breaks out of the
      // for-await early (generator .return()).
      //
      // Waiting on `drained` is the load-bearing part: the RIG is still generating until its
      // body ends, whether or not anyone is still listening. Releasing the slot at the moment
      // the consumer walks away would start the next request into a busy server and turn one
      // abandoned render into a 409 storm.
      if (stream) await stream.drained.catch(() => {})
      release()
    }
  }
}

/** App-wired speaker: base URL from the registry's tts assignment (first entry wins). */
export const speakWithPreset = createSpeaker({
  baseURL: async () => {
    const chain = await resolveChain('tts')
    const head = chain[0]
    if (!head?.baseURL) throw new Error('No TTS model configured — set one in Settings → Models')
    // The registry stores OpenAI-style base URLs ending in /v1; Breeze's own path already
    // includes /v1, so strip it to get the service root.
    return head.baseURL.replace(/\/$/, '').replace(/\/v1$/, '')
  }
})

/**
 * Speak several planned segments as ONE continuous chunk stream.
 *
 * Emits a single `begin` (from the first segment) and then every segment's PCM in order, so
 * a consumer cannot tell a split render from a whole one except by the header the route sets.
 * Each segment is a separate Breeze call taking its own queue slot, which is why the planner
 * works hard to produce one segment whenever the text fits.
 */
export async function* speakSegments(
  segments: string[],
  preset: VoicePresetDTO,
  priority: QueuePriority,
  signal?: AbortSignal,
  refAudio: Uint8Array | null = null,
  speak: ReturnType<typeof createSpeaker> = speakWithPreset
): AsyncIterable<SpeakChunk> {
  let announced = false
  for (const seg of segments) {
    for await (const c of speak(seg, preset, priority, signal, refAudio)) {
      if (c.kind === 'begin') {
        // One `begin` for the whole render: the rate cannot change between segments (same
        // preset, same engine), and a second one would reopen a segment downstream.
        if (announced) continue
        announced = true
      }
      yield c
    }
  }
}

export async function collectPcm(chunks: AsyncIterable<SpeakChunk>): Promise<{ pcm: Buffer; sampleRate: number }> {
  let sampleRate = 24000
  const parts: Uint8Array[] = []
  for await (const c of chunks) {
    if (c.kind === 'begin') sampleRate = c.sampleRate
    else parts.push(c.bytes)
  }
  return { pcm: Buffer.concat(parts), sampleRate }
}

/** Wrap headerless PCM (mono / s16le) in a 44-byte RIFF header for download/playback. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * 2          // mono * 16-bit
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)             // fmt chunk size
  header.writeUInt16LE(1, 20)              // PCM
  header.writeUInt16LE(1, 22)              // channels
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32)              // block align
  header.writeUInt16LE(16, 34)             // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, Buffer.from(pcm)])
}
