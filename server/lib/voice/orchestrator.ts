// server/lib/voice/orchestrator.ts
import { SentenceChunker } from './chunker'
import { VOICE_TUNING } from './tuning'
import type { SttProvider, TtsProvider } from './providers/types'
import type { AgentMessage, AgentEvent } from '../agent/run'
import { runAgent as realRunAgent } from '../agent/run'
import { applyImageEmbeds, type DisplayImage } from '../agent/image-embed'
import { getImageBytes } from '../../services/images'
import { getFileBytes } from '../../services/files'
import { buildUserMessageParts, type AttachmentRef } from '../agent/attachments'

export type VoiceEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'tool'; name: string; summary: string; undoToken?: string; images?: DisplayImage[] }
  | { type: 'audio'; bytes: Uint8Array }
  | { type: 'state'; state: 'thinking' | 'speaking' | 'typing' | 'tool' | 'idle' }

export interface TurnDeps {
  tts: TtsProvider
  voice: string
  signal: AbortSignal
  speak: boolean
  context?: string
  profile?: import('../agent/profile').AgentProfile
  requestApproval?: (req: import('../agent/types').ApprovalRequest) => Promise<{ approved: boolean }>
  attachments?: AttachmentRef[]
  readAttachmentBytes?: (a: AttachmentRef) => Promise<{ bytes: Buffer; mime: string } | null>
  /** Per-turn proactive memory retrieval — injected at the WS boundary (ws.ts passes
   *  the real search-backed builder; tests omit it → no injection). Never throws. */
  buildMemoryContext?: (userText: string) => Promise<string>
  emit: (e: VoiceEvent) => void
  runAgent?: (m: AgentMessage[], c: { signal: AbortSignal; speak?: boolean; context?: string; profile?: import('../agent/profile').AgentProfile; requestApproval?: (req: import('../agent/types').ApprovalRequest) => Promise<{ approved: boolean }>; attachmentImageIds?: string[] }) => AsyncGenerator<AgentEvent>
}

export interface UtteranceDeps extends TurnDeps {
  stt: SttProvider
}

/** One spoken user turn: transcribe, then run the shared turn pipeline. */
export async function handleUtterance(audio: Uint8Array, history: AgentMessage[], deps: UtteranceDeps): Promise<AgentMessage[]> {
  let userText: string
  try {
    userText = await deps.stt.transcribe(audio, { language: VOICE_TUNING.stt.language, signal: deps.signal })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return history
    throw err
  }
  return handleTurn(userText, history, deps)
}

/**
 * One user turn from already-known text — STT output or typed input injected
 * post-STT. Typed messages get the identical state/transcript/audio event
 * stream, so the client animates and answers aloud either way.
 */
export async function handleTurn(userText: string, history: AgentMessage[], deps: TurnDeps): Promise<AgentMessage[]> {
  const run = deps.runAgent ?? realRunAgent
  if (!userText) return history
  deps.emit({ type: 'transcript', role: 'user', text: userText })
  const attachments = deps.attachments ?? []
  const readBytes = deps.readAttachmentBytes ?? ((a: AttachmentRef) => a.kind === 'image' ? getImageBytes(a.id) : getFileBytes(a.id))
  const userContent = await buildUserMessageParts(userText, attachments, readBytes)
  const messages: AgentMessage[] = [...history, { role: 'user', content: userContent }]

  deps.emit({ type: 'state', state: 'thinking' })
  // Proactive memory injection: top relevant memories for THIS turn ride the
  // context block. Best-effort (returns '' on error/timeout) — never blocks a turn.
  const memoryBlock = deps.buildMemoryContext ? await deps.buildMemoryContext(userText) : ''
  const context = [deps.context, memoryBlock].filter(Boolean).join('\n\n') || undefined
  const chunker = new SentenceChunker(VOICE_TUNING.tts.sentenceMinChars)
  let assistantText = ''
  const turnImages: DisplayImage[] = []

  const speak = async (text: string) => {
    if (deps.signal.aborted) return
    deps.emit({ type: 'state', state: 'speaking' })
    try {
      for await (const bytes of deps.tts.synthesize(text, { voice: deps.voice, signal: deps.signal })) {
        if (deps.signal.aborted) return
        deps.emit({ type: 'audio', bytes })
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err
    }
  }

  let sawText = false
  for await (const ev of run(messages, { signal: deps.signal, speak: deps.speak, context, profile: deps.profile, requestApproval: deps.requestApproval, attachmentImageIds: attachments.filter(a => a.kind === 'image').map(a => a.id) })) {
    if (deps.signal.aborted) break
    if (ev.type === 'text-delta') {
      assistantText += ev.text
      deps.emit({ type: 'transcript', role: 'assistant', text: ev.text })
      if (deps.speak) {
        for (const chunk of chunker.push(ev.text)) await speak(chunk)
      } else if (!sawText) {
        // Text-only turn: no TTS; signal the client to animate a typing state.
        deps.emit({ type: 'state', state: 'typing' })
      }
      sawText = true
    } else if (ev.type === 'tool-start') {
      deps.emit({ type: 'state', state: 'tool' })
    } else if (ev.type === 'tool-result') {
      if (ev.images?.length) turnImages.push(...ev.images)
      deps.emit({ type: 'tool', name: ev.name, summary: ev.summary, undoToken: ev.undoToken, images: ev.images })
      deps.emit({ type: 'state', state: 'thinking' })
    }
  }
  if (deps.signal.aborted) return messages
  if (deps.speak) for (const chunk of chunker.flush()) await speak(chunk)
  deps.emit({ type: 'state', state: 'idle' })

  // ALWAYS sanitize the assistant text (append real embeds when an image was produced; strip any
  // stray `[image]` placeholder even when turnImages is empty — the model sometimes copies the
  // history marker without calling the tool; see image-embed.ts).
  {
    const { content, appended } = applyImageEmbeds(assistantText, turnImages)
    if (appended) deps.emit({ type: 'transcript', role: 'assistant', text: appended })  // live render
    assistantText = content
  }
  return assistantText ? [...messages, { role: 'assistant', content: assistantText }] : messages
}
