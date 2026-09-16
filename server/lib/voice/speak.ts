// Composes: queue slot -> Breeze call -> preset field mapping. The ONLY place that may
// call breezeSpeak, because the queue slot must wrap the whole stream lifetime.
import { Buffer } from 'node:buffer'
import { breezeSpeak, type BreezeRequest } from './breeze'
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
  return {
    text,
    instruction: p.instruction,
    cfgScale: p.cfgScale,
    seed: p.seed,
    temperature: p.temperature,
    topP: p.topP,
    topK: p.topK,
    refAudio: refAudio ? { bytes: refAudio, filename: 'reference.wav' } : null,
    refText: p.refText
  }
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
    const release = await queue.acquire(priority, signal)
    try {
      const base = await deps.baseURL()
      const stream = await speakFn(base, presetToRequest(text, preset, refAudio), signal)
      yield { kind: 'begin', sampleRate: stream.sampleRate }
      for await (const bytes of stream.chunks) yield { kind: 'pcm', bytes }
    } finally {
      // Runs on normal completion, on throw, AND when the consumer breaks out of the
      // for-await early (generator .return()) — all three must free the rig.
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
