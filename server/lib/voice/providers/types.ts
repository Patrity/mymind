// server/lib/voice/providers/types.ts
export interface SttProvider {
  transcribe(audio: Uint8Array, opts?: { language?: string; signal?: AbortSignal }): Promise<string>
}
export interface TtsProvider {
  /**
   * Stream synthesized audio bytes for `text` (one utterance chunk).
   * `provider` is the label of the TTS model that owns `voice` (as returned by
   * /api/voice/voices) — the failover layer dials that model first.
   */
  synthesize(text: string, opts: { voice: string; provider?: string | null; signal?: AbortSignal }): AsyncIterable<Uint8Array>
}
