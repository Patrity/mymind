// server/lib/voice/providers/index.ts
import { whisperStt } from './stt-whisper'
import { openAiTts } from './tts-openai'
import type { SttProvider, TtsProvider } from './types'
import type { ResolvedModel } from '../../ai/registry/types'

export function sttFromModel(m: ResolvedModel): SttProvider {
  return whisperStt({ baseURL: (m.baseURL ?? '').replace(/\/$/, ''), model: m.modelId, apiKey: m.apiKey ?? undefined })
}
export function ttsFromModel(m: ResolvedModel): TtsProvider {
  return openAiTts({ baseURL: (m.baseURL ?? '').replace(/\/$/, ''), model: m.modelId, apiKey: m.apiKey ?? undefined })
}
