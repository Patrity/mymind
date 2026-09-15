// server/lib/voice/providers/types.ts
import type { SpeakChunk } from '../speak'
import type { VoicePresetDTO } from '../../../../shared/types/voice-presets'

export interface SttProvider {
  transcribe(audio: Uint8Array, opts?: { language?: string; signal?: AbortSignal }): Promise<string>
}

/**
 * Breeze is the only TTS engine — there is no failover, and no `provider` label, because
 * a voice is no longer an enum a provider hands us. It is a preset we author.
 */
export interface TtsProvider {
  synthesize(text: string, opts: {
    preset: VoicePresetDTO
    /** Reference clip bytes for clone/direction presets; null for design/plain. */
    refAudio?: Uint8Array | null
    signal?: AbortSignal
  }): AsyncIterable<SpeakChunk>
}
