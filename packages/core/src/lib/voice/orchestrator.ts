// server/lib/voice/orchestrator.ts
import { VOICE_TUNING } from './tuning'
import type { SttProvider } from './providers/types'
import type { AgentMessage, AgentEvent, RunAgentCtx } from '../agent/run'
import { runAgent as realRunAgent } from '../agent/run'
import { applyImageEmbeds, sanitizedOffset, type DisplayImage } from '../agent/image-embed'
import { getImageBytes } from '../../services/images'
import { getFileBytes } from '../../services/files'
import { buildUserMessageParts, type AttachmentRef } from '../agent/attachments'
import { capResult, capArgs, WRITE_RESULT_CAP, ARGS_WRITE_CAP, type AgentToolRecord } from '../agent/tool-history'
import type { ToolsetId } from '../agent/toolsets'
import type { SubagentStep, AgentToolKind } from '../../shared/types/agent-ui'
import type { OutputWarningDTO, ToolApprovalNote } from '../agent/judge/types'
import { toolOutcome } from '../../shared/utils/agent-ui'

export type VoiceEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-start'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'approval-request'; approvalId: string; callId: string; name: string; args?: Record<string, unknown> }
  // args/result are the CAPPED copies also written to the tool record, so the live UI shows
  // exactly what a resumed thread will show.
  | { type: 'tool'; name: string; summary: string; undoToken?: string; images?: DisplayImage[]; callId?: string; args?: Record<string, unknown>; result?: unknown; kind?: AgentToolKind; approval?: ToolApprovalNote; outputWarning?: OutputWarningDTO }
  | { type: 'subagent'; parentCallId: string; steps: SubagentStep[] }
  // The timing fields are NOT produced by the model stream (the run loop emits tokens only) —
  // ws.ts owns the turn clock and re-emits usage with them filled in once the turn ends, so the
  // live message-metadata chunk carries the same duration/tok-s the persisted row will.
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number; contextTokens?: number; modelDefId?: string; startedAt?: string; ttftMs?: number; durationMs?: number }
  | { type: 'state'; state: 'thinking' | 'speaking' | 'typing' | 'tool' | 'idle' }

// Cycle 81 (spec §4): no TTS here any more. The turn runs in the worker and streams text; the web's
// voice socket speaks it for the originating tab (lib/voice/turn-speaker.ts via server/lib/voice/
// socket-tts.ts). `speak` still reaches the model (it answers in its spoken style).
export interface TurnDeps {
  signal: AbortSignal
  speak: boolean
  context?: string
  modelDefId?: string | null
  profile?: import('../agent/profile').AgentProfile
  requestApproval?: import('../agent/types').RequestApproval
  /** Cycle 84 Task 2: forwarded verbatim into runAgent's ctx (the approval surface + workstream). */
  approvals?: import('../agent/run').RunAgentCtx['approvals']
  attachments?: AttachmentRef[]
  readAttachmentBytes?: (a: AttachmentRef) => Promise<{ bytes: Buffer; mime: string } | null>
  /** Per-turn proactive memory retrieval — injected at the WS boundary (ws.ts passes
   *  the real search-backed builder; tests omit it → no injection). Never throws. */
  buildMemoryContext?: (userText: string) => Promise<string>
  emit: (e: VoiceEvent) => void
  /** Drains messages Tony sent mid-turn (runtime runner, Task 7/9) — forwarded verbatim into
   *  runAgent's ctx, which splices them into the running streamText loop at each step boundary. */
  drainSteer?: () => Promise<string[]>
  /** Present only for a headless/background wake (runtime runner) — forwarded verbatim into
   *  runAgent's ctx to switch the system prompt into wake mode (NO_REPLY contract, no confirm-first). */
  wake?: { reason: string }
  /** The agent_runs row of this turn (runtime runner) — forwarded into runAgent's ctx so tools
   *  see it as ToolContext.runId. */
  runId?: string
  /** Cycle 78: on-demand toolsets for this turn — the initial set (stored + job-declared) and
   *  the runner's persistence callback, fired when runAgent loads something new mid-turn.
   *  Absent for subagents/legacy chat.post, same as runAgent's own ctx.toolsets. */
  toolsets?: { initial: ToolsetId[]; onChange?: (loaded: ToolsetId[]) => void | Promise<void>; unavailable?: ToolsetId[] }
  /** Cycle 81 (workstream segments): forwarded verbatim into runAgent's ctx — the segment's step cap,
   *  its stop-after-this-step check, per-step accounting and its prompt block. */
  maxSteps?: number
  shouldStop?: RunAgentCtx['shouldStop']
  onStep?: RunAgentCtx['onStep']
  workstream?: RunAgentCtx['workstream']
  /** Cycle 83: a child workstream's segment runs on its subagents chain. */
  subagent?: RunAgentCtx['subagent']
  runAgent?: (m: AgentMessage[], c: RunAgentCtx) => AsyncGenerator<AgentEvent>
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
 * post-STT. Typed messages get the identical state/transcript event stream, so the
 * client animates (and, with `speak`, the web's voice socket answers aloud) either way.
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
  let assistantText = ''
  const turnImages: DisplayImage[] = []
  const toolRecords: AgentToolRecord[] = []

  // A subagent's nested calls, keyed by the PARENT call — emitted live as the full list and
  // persisted (terminal states only) on the parent's tool record.
  const subagentSteps = new Map<string, SubagentStep[]>()

  let sawText = false
  const ws = { ...(deps.maxSteps !== undefined ? { maxSteps: deps.maxSteps } : {}), ...(deps.shouldStop ? { shouldStop: deps.shouldStop } : {}), ...(deps.onStep ? { onStep: deps.onStep } : {}), ...(deps.workstream ? { workstream: deps.workstream } : {}), ...(deps.subagent ? { subagent: deps.subagent } : {}), ...(deps.approvals ? { approvals: deps.approvals } : {}) }
  for await (const ev of run(messages, { signal: deps.signal, speak: deps.speak, context, modelDefId: deps.modelDefId, profile: deps.profile, requestApproval: deps.requestApproval, attachmentImageIds: attachments.filter(a => a.kind === 'image').map(a => a.id), drainSteer: deps.drainSteer, wake: deps.wake, runId: deps.runId, toolsets: deps.toolsets, ...ws })) {
    if (deps.signal.aborted) break
    if (ev.type === 'reasoning-delta') {
      deps.emit({ type: 'reasoning', text: ev.text })   // display only — never chunked/spoken/persisted here
    } else if (ev.type === 'usage') {
      // Metadata only, same as reasoning above: never touches assistantText, the
      // transcript events, or the TTS chunker — it isn't part of what the user hears/reads.
      deps.emit({ type: 'usage', inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, totalTokens: ev.totalTokens, contextTokens: ev.contextTokens, modelDefId: ev.modelDefId })
    } else if (ev.type === 'text-delta') {
      assistantText += ev.text
      deps.emit({ type: 'transcript', role: 'assistant', text: ev.text })
      // Text is streaming: the client animates a typing state. For a spoken turn the web's voice
      // socket withholds this from the originating tab, which shows `speaking` once audio starts.
      if (!sawText) deps.emit({ type: 'state', state: 'typing' })
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
          ...(ev.approval ? { approval: ev.approval } : {}),
          ...(ev.outputWarning ? { outputWarning: ev.outputWarning } : {}),
          ...(steps?.length ? { steps: steps.map(s => s.state === 'running' ? { ...s, state: 'error' as const } : s) } : {})
        })
      }
      deps.emit({ type: 'tool', name: ev.name, summary: ev.summary, undoToken: ev.undoToken, images: ev.images, callId: ev.callId, args, result, kind: ev.kind, ...(ev.approval ? { approval: ev.approval } : {}), ...(ev.outputWarning ? { outputWarning: ev.outputWarning } : {}) })
      deps.emit({ type: 'state', state: 'thinking' })
    }
  }
  if (deps.signal.aborted) return messages
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
