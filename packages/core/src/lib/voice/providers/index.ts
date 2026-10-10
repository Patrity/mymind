// server/lib/voice/providers/index.ts
import { whisperStt } from './stt-whisper'
import type { SttProvider } from './types'
import type { ResolvedModel } from '../../ai/registry/types'

export function sttFromModel(m: ResolvedModel): SttProvider {
  return whisperStt({ baseURL: (m.baseURL ?? '').replace(/\/$/, ''), model: m.modelId, apiKey: m.apiKey ?? undefined })
}
// ttsFromModel is GONE. TTS no longer resolves per-model: see server/lib/voice/speak.ts.
