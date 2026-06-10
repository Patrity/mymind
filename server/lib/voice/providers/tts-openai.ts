// server/lib/voice/providers/tts-openai.ts
import type { TtsProvider } from './types'

/** OpenAI-spec /v1/audio/speech provider — works for Kokoro AND Chatterbox. */
export function openAiTts(cfg: { baseURL: string; model: string; apiKey?: string }): TtsProvider {
  const base = cfg.baseURL.replace(/\/$/, '')
  return {
    async *synthesize(text, opts) {
      const res = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        signal: opts.signal,
        body: JSON.stringify({ model: cfg.model, voice: opts.voice, input: text, response_format: 'wav' })
      })
      if (!res.ok || !res.body) throw new Error(`TTS failed: ${res.status}`)
      // The server returns ONE WAV per request. Each chunk we yield is sent as a
      // single binary frame and the client decodes it whole (decodeAudioData), so we
      // must NOT forward header-less network fragments — only the first would carry
      // the RIFF header and the rest would be dropped (clipped/skipped words).
      // Buffer the full body and yield one complete, self-contained WAV.
      yield new Uint8Array(await res.arrayBuffer())
    }
  }
}
