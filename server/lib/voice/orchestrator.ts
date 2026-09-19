// server/lib/voice/orchestrator.ts
import { SpeechChunker } from './segment'
import { SpeechPipeline } from './pipeline'
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
import type { SubagentStep, AgentToolKind } from '../../../shared/types/agent-ui'
import { toolOutcome } from '../../../shared/utils/agent-ui'

export type VoiceEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-start'; callId: string; name: string; args: Record<string, unknown> }
  // args/result are the CAPPED copies also written to the tool record, so the live UI shows
  // exactly what a resumed thread will show.
  | { type: 'tool'; name: string; summary: string; undoToken?: string; images?: DisplayImage[]; callId?: string; args?: Record<string, unknown>; result?: unknown; kind?: AgentToolKind }
  | { type: 'subagent'; parentCallId: string; steps: SubagentStep[] }
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
  const pipeline = new SpeechPipeline({
    synthesize: (text, opts) => deps.tts.synthesize(text, opts),
    preset: deps.preset,
    refAudio: deps.refAudio,
    signal: deps.signal,
    concurrency: VOICE_TUNING.tts.pipelineConcurrency,
    onSpeaking: () => deps.emit({ type: 'state', state: 'speaking' }),
    onChunk: (c) => {
      if (c.kind === 'begin') {
        segmentId++
        segmentOpen = true
        deps.emit({ type: 'audio-begin', segmentId, sampleRate: c.sampleRate })
      } else {
        deps.emit({ type: 'audio', bytes: c.bytes })
      }
    },
    onSegmentEnd: () => {
      if (!segmentOpen) return
      segmentOpen = false
      deps.emit({ type: 'audio-end', segmentId })
    }
  })

  // A subagent's nested calls, keyed by the PARENT call — emitted live as the full list and
  // persisted (terminal states only) on the parent's tool record.
  const subagentSteps = new Map<string, SubagentStep[]>()

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
      if (ev.callId) deps.emit({ type: 'tool-start', callId: ev.callId, name: ev.name, args: capArgs(ev.args, ARGS_WRITE_CAP) })
    } else if (ev.type === 'subagent-event') {
      const steps = subagentSteps.get(ev.parentCallId) ?? []
      const n = ev.event
      if (n.type === 'tool-start') {
        steps.push({ callId: n.callId ?? `${ev.parentCallId}-n${steps.length}`, name: n.name, state: 'running' })
      } else {
        const i = n.callId ? steps.findIndex(s => s.callId === n.callId) : steps.findIndex(s => s.name === n.name && s.state === 'running')
        const done: SubagentStep = { callId: n.callId ?? `${ev.parentCallId}-n${steps.length}`, name: n.name, summary: n.summary, state: toolOutcome(n.result).state === 'ok' ? 'done' : 'error' }
        if (i >= 0) steps[i] = done
        else steps.push(done)
      }
      subagentSteps.set(ev.parentCallId, steps)
      deps.emit({ type: 'subagent', parentCallId: ev.parentCallId, steps: steps.map(s => ({ ...s })) })
    } else if (ev.type === 'tool-result') {
      if (ev.images?.length) turnImages.push(...ev.images)
      // Capped ONCE: the same objects are persisted and sent live (UI parity with resume).
      const args = capArgs(ev.args, ARGS_WRITE_CAP)
      const result = capResult(ev.result, WRITE_RESULT_CAP)
      if (ev.callId) {
        const steps = subagentSteps.get(ev.callId)
        toolRecords.push({
          // BOTH payloads are capped at capture: a write tool's args carry the whole document
          // body, and an uncapped one would be persisted and re-sent on every later turn.
          callId: ev.callId, name: ev.name, kind: ev.kind ?? 'read',
          args, result, summary: ev.summary,
          // Offset into the SANITIZED text, not the raw stream: what gets persisted below is
          // applyImageEmbeds(assistantText).content, which trims and collapses whitespace, so
          // a raw length would index a string that no longer exists (see sanitizedOffset).
          undoToken: ev.undoToken, textOffset: sanitizedOffset(assistantText),
          ...(steps?.length ? { steps: steps.map(s => s.state === 'running' ? { ...s, state: 'error' as const } : s) } : {})
        })
      }
      deps.emit({ type: 'tool', name: ev.name, summary: ev.summary, undoToken: ev.undoToken, images: ev.images, callId: ev.callId, args, result, kind: ev.kind })
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
