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
      const reader = res.body.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) yield value
      }
    }
  }
}
