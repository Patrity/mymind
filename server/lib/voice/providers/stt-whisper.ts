// server/lib/voice/providers/stt-whisper.ts
import type { SttProvider } from './types'

export function whisperStt(cfg: { baseURL: string; model: string; apiKey?: string }): SttProvider {
  const base = cfg.baseURL.replace(/\/$/, '')
  return {
    async transcribe(audio, opts) {
      const form = new FormData()
      form.append('file', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'utterance.wav')
      form.append('model', cfg.model)
      if (opts?.language) form.append('language', opts.language)
      const res = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : undefined,
        body: form
      })
      if (!res.ok) throw new Error(`STT failed: ${res.status}`)
      const json = await res.json() as { text?: string }
      return (json.text ?? '').trim()
    }
  }
}
