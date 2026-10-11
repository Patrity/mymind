// One spoken turn: streamed assistant text in, paired audio frames out. Cycle 81 (spec §4) moved
// this out of the orchestrator — the worker that runs the model no longer synthesizes; the web's
// voice socket feeds it the text deltas it streams to the originating tab (server/lib/voice/
// socket-tts.ts). The rules are the orchestrator's, unchanged:
//   - the RAW text is segmented, each completed segment sanitized (SpeechChunker) — markdown
//     never reaches the synth, and an IP address is never fragmented across calls;
//   - the segment cap is per preset (a clone carries its reference in every prompt);
//   - segments are strictly serial (Breeze is single-request) and their PCM is emitted as the
//     engine produces it (SpeechPipeline);
//   - `audio-begin`/`audio-end` are strictly PAIRED: a segment whose synthesis threw or aborted
//     before yielding its `begin` never opened on the wire, so it emits no `audio-end` either.
import { SpeechChunker } from './segment'
import { SpeechPipeline } from './pipeline'
import { VOICE_TUNING } from './tuning'
import type { TtsProvider } from './providers/types'
import type { VoicePresetDTO } from '../../shared/types/voice-presets'

export type SpeakerEvent =
  | { type: 'speaking' }
  | { type: 'audio-begin'; segmentId: number; sampleRate: number }
  | { type: 'audio'; bytes: Uint8Array }
  | { type: 'audio-end'; segmentId: number }

export interface TurnSpeakerOptions {
  synthesize: TtsProvider['synthesize']
  preset: VoicePresetDTO
  /** Reference clip bytes for a clone/direction preset; null for design/plain. */
  refAudio?: Uint8Array | null
  signal: AbortSignal
  emit: (e: SpeakerEvent) => void
}

export interface TurnSpeaker {
  /** Feed one text delta. Resolves once any segment it completed is enqueued (at concurrency 1:
   *  once the previous segment has finished). */
  push(text: string): Promise<void>
  /** End of the turn's text: speak the tail and wait until every segment has played out. */
  finish(): Promise<void>
}

export function createTurnSpeaker(o: TurnSpeakerOptions): TurnSpeaker {
  const maxChars = Math.min(VOICE_TUNING.tts.sentenceMaxChars, o.preset.maxSegmentChars)
  const chunker = new SpeechChunker(
    Math.min(VOICE_TUNING.tts.sentenceMinChars, maxChars),
    maxChars,
    Math.min(VOICE_TUNING.tts.firstSegmentMaxChars, maxChars)
  )
  let segmentId = 0
  let segmentOpen = false
  const pipeline = new SpeechPipeline({
    synthesize: o.synthesize,
    preset: o.preset,
    refAudio: o.refAudio,
    signal: o.signal,
    concurrency: VOICE_TUNING.tts.pipelineConcurrency,
    onSpeaking: () => o.emit({ type: 'speaking' }),
    onChunk: (c) => {
      if (c.kind === 'begin') {
        segmentId++
        segmentOpen = true
        o.emit({ type: 'audio-begin', segmentId, sampleRate: c.sampleRate })
      } else {
        o.emit({ type: 'audio', bytes: c.bytes })
      }
    },
    onSegmentEnd: () => {
      if (!segmentOpen) return
      segmentOpen = false
      o.emit({ type: 'audio-end', segmentId })
    }
  })
  return {
    async push(text) {
      if (o.signal.aborted) return
      for (const chunk of chunker.push(text)) await pipeline.push(chunk)
    },
    async finish() {
      if (o.signal.aborted) return
      for (const chunk of chunker.flush()) await pipeline.push(chunk)
      await pipeline.drain()
    }
  }
}
