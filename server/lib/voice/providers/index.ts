// server/lib/voice/providers/index.ts
import { whisperStt } from './stt-whisper'
import { openAiTts } from './tts-openai'
import type { SttProvider, TtsProvider } from './types'

export type TtsName = 'kokoro' | 'chatterbox'
type AiCfg = { baseURL?: string; apiKey?: string; model?: string; voice?: string }
const ai = () => (useRuntimeConfig().ai as Record<string, AiCfg>)

export function makeStt(): SttProvider {
  const c = ai().stt ?? {}
  return whisperStt({ baseURL: c.baseURL!, model: c.model || 'deepdml/faster-whisper-large-v3-turbo-ct2', apiKey: c.apiKey })
}
export function makeTts(name: TtsName): TtsProvider {
  const c = ai()[name === 'kokoro' ? 'ttsKokoro' : 'ttsChatterbox'] ?? {}
  return openAiTts({ baseURL: c.baseURL!, model: c.model || name, apiKey: c.apiKey })
}
export function defaultVoice(name: TtsName): string {
  const c = ai()[name === 'kokoro' ? 'ttsKokoro' : 'ttsChatterbox'] ?? {}
  return c.voice || (name === 'kokoro' ? 'af_heart' : 'happy-us.wav')
}
