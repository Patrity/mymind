// server/lib/voice/providers/index.ts
import { whisperStt } from './stt-whisper'
import { openAiTts } from './tts-openai'
import type { SttProvider, TtsProvider } from './types'

export type TtsName = 'kokoro' | 'chatterbox'
type AiCfg = { baseURL?: string; apiKey?: string; model?: string; voice?: string }
const ai = () => (useRuntimeConfig().ai as Record<string, AiCfg>)

export function makeStt(): SttProvider {
  const c = ai().stt ?? {}
  // Fail with a config message, not a cryptic relative-URL fetch error.
  if (!c.baseURL) throw new Error('STT is not configured (set AI_STT_BASE_URL)')
  return whisperStt({ baseURL: c.baseURL, model: c.model || 'deepdml/faster-whisper-large-v3-turbo-ct2', apiKey: c.apiKey })
}
export function makeTts(name: TtsName): TtsProvider {
  const c = ai()[name === 'kokoro' ? 'ttsKokoro' : 'ttsChatterbox'] ?? {}
  if (!c.baseURL) throw new Error(`TTS provider "${name}" is not configured (set AI_TTS_${name.toUpperCase()}_BASE_URL)`)
  return openAiTts({ baseURL: c.baseURL, model: c.model || name, apiKey: c.apiKey })
}
export function defaultVoice(name: TtsName): string {
  const c = ai()[name === 'kokoro' ? 'ttsKokoro' : 'ttsChatterbox'] ?? {}
  return c.voice || (name === 'kokoro' ? 'af_heart' : 'happy-us.wav')
}
