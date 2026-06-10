// server/lib/voice/orchestrator.ts
import { SentenceChunker } from './chunker'
import { VOICE_TUNING } from './tuning'
import type { SttProvider, TtsProvider } from './providers/types'
import type { AgentMessage, AgentEvent } from '../agent/run'
import { runAgent as realRunAgent } from '../agent/run'

export type VoiceEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'tool'; name: string; summary: string; undoToken?: string }
  | { type: 'audio'; bytes: Uint8Array }
  | { type: 'state'; state: 'thinking' | 'speaking' | 'idle' }

export interface UtteranceDeps {
  stt: SttProvider
  tts: TtsProvider
  voice: string
  signal: AbortSignal
  emit: (e: VoiceEvent) => void
  runAgent?: (m: AgentMessage[], c: { signal: AbortSignal }) => AsyncGenerator<AgentEvent>
}

/** One user turn: transcribe -> run the agent -> speak chunked replies. */
export async function handleUtterance(audio: Uint8Array, history: AgentMessage[], deps: UtteranceDeps): Promise<AgentMessage[]> {
  const run = deps.runAgent ?? realRunAgent
  const userText = await deps.stt.transcribe(audio, { language: VOICE_TUNING.stt.language })
  if (!userText) return history
  deps.emit({ type: 'transcript', role: 'user', text: userText })
  const messages: AgentMessage[] = [...history, { role: 'user', content: userText }]

  deps.emit({ type: 'state', state: 'thinking' })
  const chunker = new SentenceChunker(VOICE_TUNING.tts.sentenceMinChars)
  let assistantText = ''

  const speak = async (text: string) => {
    if (deps.signal.aborted) return
    deps.emit({ type: 'state', state: 'speaking' })
    for await (const bytes of deps.tts.synthesize(text, { voice: deps.voice, signal: deps.signal })) {
      if (deps.signal.aborted) return
      deps.emit({ type: 'audio', bytes })
    }
  }

  for await (const ev of run(messages, { signal: deps.signal })) {
    if (deps.signal.aborted) break
    if (ev.type === 'text-delta') {
      assistantText += ev.text
      deps.emit({ type: 'transcript', role: 'assistant', text: ev.text })
      for (const chunk of chunker.push(ev.text)) await speak(chunk)
    } else if (ev.type === 'tool-result') {
      deps.emit({ type: 'tool', name: ev.name, summary: ev.summary, undoToken: ev.undoToken })
    }
  }
  for (const chunk of chunker.flush()) await speak(chunk)
  deps.emit({ type: 'state', state: 'idle' })

  return assistantText ? [...messages, { role: 'assistant', content: assistantText }] : messages
}
