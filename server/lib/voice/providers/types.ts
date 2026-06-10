// server/lib/voice/providers/types.ts
export interface SttProvider {
  transcribe(audio: Uint8Array, opts?: { language?: string; signal?: AbortSignal }): Promise<string>
}
export interface TtsProvider {
  /** Stream synthesized audio bytes for `text` (one utterance chunk). */
  synthesize(text: string, opts: { voice: string; signal?: AbortSignal }): AsyncIterable<Uint8Array>
}
