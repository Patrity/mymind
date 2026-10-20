// server/lib/voice/providers/stt-whisper.ts
import type { SttProvider } from './types'
import { toWav16k } from './wav-transcode'

type ToWav = (audio: Uint8Array, deps?: { signal?: AbortSignal }) => Promise<{ audio: Uint8Array; converted: boolean }>

/**
 * OpenAI-compatible `/audio/transcriptions`. The backend (audio.cpp Parakeet) decodes WAV
 * only, so non-WAV input (iMessage memos: MP3/AAC/CAF) is transcoded to 16 kHz mono WAV first.
 * `toWav` is injectable for tests.
 */
export function whisperStt(cfg: { baseURL: string; model: string; apiKey?: string; toWav?: ToWav }): SttProvider {
  const base = cfg.baseURL.replace(/\/$/, '')
  const toWav: ToWav = cfg.toWav ?? ((a, d) => toWav16k(a, { signal: d?.signal }))
  return {
    async transcribe(audio, opts) {
      const { audio: bytes, converted } = await toWav(audio, { signal: opts?.signal })
      const mime = converted ? 'audio/wav' : (opts?.mime ?? 'audio/wav')
      const filename = converted
        ? `${(opts?.filename ?? 'utterance').replace(/\.[^./]+$/, '')}.wav`
        : (opts?.filename ?? 'utterance.wav')
      const form = new FormData()
      form.append('file', new Blob([bytes as BlobPart], { type: mime }), filename)
      form.append('model', cfg.model)
      if (opts?.language) form.append('language', opts.language)
      const res = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : undefined,
        body: form,
        signal: opts?.signal,
      })
      if (!res.ok) throw new Error(`STT failed: ${res.status}`)
      const json = await res.json() as { text?: string }
      return (json.text ?? '').trim()
    }
  }
}
