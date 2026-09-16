// server/lib/voice/orchestrator.ts
import { SpeechChunker } from './segment'
import { SpeechPipeline } from './pipeline'
import { createVoiceChain, chainedPreset, shouldChain } from './voice-chain'
import { VOICE_TUNING } from './tuning'
import type { SttProvider, TtsProvider } from './providers/types'
import type { AgentMessage, AgentEvent } from '../agent/run'
import { runAgent as realRunAgent } from '../agent/run'
import { applyImageEmbeds, sanitizedOffset, type DisplayImage } from '../agent/image-embed'
import { getImageBytes } from '../../services/images'
import { getFileBytes } from '../../services/files'
import { buildUserMessageParts, type AttachmentRef } from '../agent/attachments'
import { capResult, capArgs, WRITE_RESULT_CAP, ARGS_WRITE_CAP, type AgentToolRecord } from '../agent/tool-history'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

export type VoiceEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; name: string; summary: string; undoToken?: string; images?: DisplayImage[] }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | { type: 'audio-begin'; segmentId: number; sampleRate: number }
  | { type: 'audio'; bytes: Uint8Array }
  | { type: 'audio-end'; segmentId: number }
  | { type: 'state'; state: 'thinking' | 'speaking' | 'typing' | 'tool' | 'idle' }

export interface TurnDeps {
  tts: TtsProvider
  /** The voice to speak in. Resolved at the WS boundary (ws.ts) from the client's
   *  cookie-backed preset id, falling back to the default preset. */
  preset: VoicePresetDTO
  /** Reference clip bytes for a clone/direction preset; null for design/plain. */
  refAudio?: Uint8Array | null
  signal: AbortSignal
  speak: boolean
  context?: string
  modelDefId?: string | null
  profile?: import('../agent/profile').AgentProfile
  requestApproval?: (req: import('../agent/types').ApprovalRequest) => Promise<{ approved: boolean }>
  attachments?: AttachmentRef[]
  readAttachmentBytes?: (a: AttachmentRef) => Promise<{ bytes: Buffer; mime: string } | null>
  /** Per-turn proactive memory retrieval — injected at the WS boundary (ws.ts passes
   *  the real search-backed builder; tests omit it → no injection). Never throws. */
  buildMemoryContext?: (userText: string) => Promise<string>
  emit: (e: VoiceEvent) => void
  runAgent?: (m: AgentMessage[], c: { signal: AbortSignal; speak?: boolean; context?: string; modelDefId?: string | null; profile?: import('../agent/profile').AgentProfile; requestApproval?: (req: import('../agent/types').ApprovalRequest) => Promise<{ approved: boolean }>; attachmentImageIds?: string[] }) => AsyncGenerator<AgentEvent>
}

export interface UtteranceDeps extends TurnDeps {
  stt: SttProvider
}

/** One spoken user turn: transcribe, then run the shared turn pipeline. */
export async function handleUtterance(audio: Uint8Array, history: AgentMessage[], deps: UtteranceDeps): Promise<AgentMessage[]> {
  // Turns queue behind the connection lock (ws.ts), but the AbortController fires the
  // instant the NEXT frame lands — so by the time a queued turn runs, its own signal may
  // already be dead. Don't burn an STT round-trip on it (prod showed 0-2ms transcribes).
  if (deps.signal.aborted) return history
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
  // The segment cap is per-preset: a clone-backed preset carries its reference in every
  // prompt, so it may not be safe at the default 200 (see calibrateMaxSegmentChars).
  const maxChars = Math.min(VOICE_TUNING.tts.sentenceMaxChars, deps.preset.maxSegmentChars)
  const chunker = new SpeechChunker(
    Math.min(VOICE_TUNING.tts.sentenceMinChars, maxChars),
    maxChars,
    Math.min(VOICE_TUNING.tts.firstSegmentMaxChars, maxChars)
  )
  let assistantText = ''
  const turnImages: DisplayImage[] = []
  const toolRecords: AgentToolRecord[] = []

  // Segments are strictly serial (Breeze is single-request) but their chunks are emitted
  // as the engine produces them — see pipeline.ts. Each segment is bracketed by an
  // `audio-begin` (carrying the sample rate the client must decode at) and an
  // `audio-end`; the raw PCM in between rides `audio` frames.
  let segmentId = 0
  // `audio-begin`/`audio-end` are strictly PAIRED. The pipeline fires onSegmentEnd for
  // every segment including a dropped one (it owns lifetimes, not frame semantics), but a
  // segment whose synthesis threw or aborted before yielding its `begin` never opened on
  // the wire — and `segmentId` still holds its PREDECESSOR's value, so emitting anyway
  // would close an already-closed segment, naming an id that really did begin. A frame
  // reporting an end that never happened is a lying frame; suppress it here instead.
  let segmentOpen = false
  // ONE speaker for the whole turn. Breeze holds no speaker state between calls, so without
  // this each segment casts a fresh person — measured at a 142 Hz spread across four
  // segments of one reply, a man's voice and a woman's inside the same answer. Segment one
  // is a recording of the voice we want and we know its exact text, so it anchors the rest
  // (spread falls to 19.2 Hz). A preset with its own reference clip is left alone: a chosen
  // clip anchors better than a synthetic first segment.
  const chain = createVoiceChain(24000, shouldChain(deps.preset))

  const pipeline = new SpeechPipeline({
    synthesize: (text, opts) => deps.tts.synthesize(text, opts),
    preset: deps.preset,
    refAudio: deps.refAudio,
    signal: deps.signal,
    concurrency: VOICE_TUNING.tts.pipelineConcurrency,
    resolveVoice: () => {
      const ref = chain.reference()
      // Null until segment one has finished, so segment one renders exactly as before and
      // goes out as soon as the first words arrive — streaming behaviour is untouched.
      return ref
        ? { preset: chainedPreset(deps.preset, ref), refAudio: ref.audio }
        : { preset: deps.preset, refAudio: deps.refAudio ?? null }
    },
    onSpeaking: () => deps.emit({ type: 'state', state: 'speaking' }),
    onChunk: (c, segmentText) => {
      if (c.kind === 'begin') {
        segmentId++
        segmentOpen = true
        deps.emit({ type: 'audio-begin', segmentId, sampleRate: c.sampleRate })
      } else {
        chain.capture(segmentText, c.bytes)
        deps.emit({ type: 'audio', bytes: c.bytes })
      }
    },
    onSegmentEnd: () => {
      chain.endSegment()
      if (!segmentOpen) return
      segmentOpen = false
      deps.emit({ type: 'audio-end', segmentId })
    }
  })

  let sawText = false
  for await (const ev of run(messages, { signal: deps.signal, speak: deps.speak, context, modelDefId: deps.modelDefId, profile: deps.profile, requestApproval: deps.requestApproval, attachmentImageIds: attachments.filter(a => a.kind === 'image').map(a => a.id) })) {
    if (deps.signal.aborted) break
    if (ev.type === 'reasoning-delta') {
      deps.emit({ type: 'reasoning', text: ev.text })   // display only — never chunked/spoken/persisted here
    } else if (ev.type === 'usage') {
      // Metadata only, same as reasoning above: never touches assistantText, the
      // transcript events, or the TTS chunker — it isn't part of what the user hears/reads.
      deps.emit({ type: 'usage', inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, totalTokens: ev.totalTokens })
    } else if (ev.type === 'text-delta') {
      assistantText += ev.text
      deps.emit({ type: 'transcript', role: 'assistant', text: ev.text })
      if (deps.speak) {
        for (const chunk of chunker.push(ev.text)) await pipeline.push(chunk)
      } else if (!sawText) {
        // Text-only turn: no TTS; signal the client to animate a typing state.
        deps.emit({ type: 'state', state: 'typing' })
      }
      sawText = true
    } else if (ev.type === 'tool-start') {
      deps.emit({ type: 'state', state: 'tool' })
    } else if (ev.type === 'tool-result') {
      if (ev.images?.length) turnImages.push(...ev.images)
      if (ev.callId) {
        toolRecords.push({
          // BOTH payloads are capped at capture: a write tool's args carry the whole document
          // body, and an uncapped one would be persisted and re-sent on every later turn.
          callId: ev.callId, name: ev.name, kind: ev.kind ?? 'read',
          args: capArgs(ev.args, ARGS_WRITE_CAP), result: capResult(ev.result, WRITE_RESULT_CAP), summary: ev.summary,
          // Offset into the SANITIZED text, not the raw stream: what gets persisted below is
          // applyImageEmbeds(assistantText).content, which trims and collapses whitespace, so
          // a raw length would index a string that no longer exists (see sanitizedOffset).
          undoToken: ev.undoToken, textOffset: sanitizedOffset(assistantText)
        })
      }
      deps.emit({ type: 'tool', name: ev.name, summary: ev.summary, undoToken: ev.undoToken, images: ev.images })
      deps.emit({ type: 'state', state: 'thinking' })
    }
  }
  if (deps.signal.aborted) return messages
  if (deps.speak) {
    for (const chunk of chunker.flush()) await pipeline.push(chunk)
    await pipeline.drain()
  }
  deps.emit({ type: 'state', state: 'idle' })

  // ALWAYS sanitize the assistant text (append real embeds when an image was produced; strip any
  // stray `[image]` placeholder even when turnImages is empty — the model sometimes copies the
  // history marker without calling the tool; see image-embed.ts).
  {
    const { content, appended } = applyImageEmbeds(assistantText, turnImages)
    if (appended) deps.emit({ type: 'transcript', role: 'assistant', text: appended })  // live render
    assistantText = content
  }
  return assistantText
    ? [...messages, { role: 'assistant', content: assistantText, ...(toolRecords.length ? { toolRecords } : {}) }]
    : messages
}
