// Composes: queue slot -> Breeze call -> preset field mapping. The ONLY place that may
// call breezeSpeak, because the queue slot must wrap the whole stream lifetime.
import { Buffer } from 'node:buffer'
import { breezeSpeak, type BreezeRequest } from './breeze'
import { breezeQueue, type BreezeQueue, type QueuePriority } from './breeze-queue'
import { resolveChain } from '../ai/registry/resolve'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

export type SpeakChunk =
  | { kind: 'begin'; sampleRate: number }
  | { kind: 'pcm'; bytes: Uint8Array }

export interface SpeakDeps {
  baseURL: () => Promise<string>
  queue?: BreezeQueue
  speakFn?: typeof breezeSpeak
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
