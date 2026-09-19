// Pure VoiceEvent → AI SDK UIMessageChunk encoder: one instance per assistant turn. The
// client assembles its output with the SDK's own readUIMessageStream, so the chunk sequence
// must be one that assembler accepts — ui-stream.test.ts proves each mapping against it.
import type { VoiceEvent } from './orchestrator'
import type { AgentUIChunk } from '../../../shared/types/agent-ui'
import { toolOutcome, toolEnvelope } from '../../../shared/utils/agent-ui'

export interface UIChunkEncoder {
  start(createdAt: string): AgentUIChunk[]
  encode(e: VoiceEvent): AgentUIChunk[]
  finish(): AgentUIChunk[]
  error(errorText: string): AgentUIChunk[]
  abort(): AgentUIChunk[]
}

export function createUIChunkEncoder(messageId: string): UIChunkEncoder {
  let open: { kind: 'text' | 'reasoning'; id: string } | null = null
  let seq = 0
  const started = new Set<string>()

  const close = (): AgentUIChunk[] => {
    if (!open) return []
    const chunk: AgentUIChunk = open.kind === 'text' ? { type: 'text-end', id: open.id } : { type: 'reasoning-end', id: open.id }
    open = null
    return [chunk]
  }
  const delta = (kind: 'text' | 'reasoning', value: string): AgentUIChunk[] => {
    const out = open?.kind === kind ? [] : close()
    if (!open) {
      open = { kind, id: `${messageId}-${kind}-${seq++}` }
      out.push(kind === 'text' ? { type: 'text-start', id: open.id } : { type: 'reasoning-start', id: open.id })
    }
    out.push(kind === 'text' ? { type: 'text-delta', id: open.id, delta: value } : { type: 'reasoning-delta', id: open.id, delta: value })
    return out
  }
  const input = (callId: string, name: string, args: Record<string, unknown>): AgentUIChunk[] => {
    started.add(callId)
    return [{ type: 'tool-input-available', toolCallId: callId, toolName: name, input: args, dynamic: true }]
  }

  return {
    start: createdAt => [{ type: 'start', messageId, messageMetadata: { createdAt } }, { type: 'start-step' }],

    encode(e) {
      switch (e.type) {
        case 'transcript':
          return e.role === 'assistant' && e.text ? delta('text', e.text) : []
        case 'reasoning':
          return e.text ? delta('reasoning', e.text) : []
        case 'tool-start':
          return [...close(), ...input(e.callId, e.name, e.args)]
        case 'tool': {
          if (!e.callId) return [] // legacy event without an id: cannot be paired, skip it
          const out = close()
          if (!started.has(e.callId)) out.push(...input(e.callId, e.name, e.args ?? {}))
          const outcome = toolOutcome(e.result)
          if (outcome.state === 'denied') out.push({ type: 'tool-output-denied', toolCallId: e.callId })
          else if (outcome.state === 'error') out.push({ type: 'tool-output-error', toolCallId: e.callId, errorText: outcome.errorText, dynamic: true })
          else out.push({ type: 'tool-output-available', toolCallId: e.callId, output: toolEnvelope({ result: e.result, summary: e.summary, undoToken: e.undoToken, kind: e.kind }), dynamic: true })
          return out
        }
        case 'subagent':
          return [{ type: 'data-subagent', id: e.parentCallId, data: { steps: e.steps } }]
        case 'usage': {
          const usage = {
            ...(e.inputTokens !== undefined ? { inputTokens: e.inputTokens } : {}),
            ...(e.outputTokens !== undefined ? { outputTokens: e.outputTokens } : {}),
            ...(e.totalTokens !== undefined ? { totalTokens: e.totalTokens } : {}),
            ...(e.contextTokens !== undefined ? { contextTokens: e.contextTokens } : {}),
            ...(e.modelDefId !== undefined ? { modelDefId: e.modelDefId } : {})
          }
          return [{ type: 'message-metadata', messageMetadata: { usage } }]
        }
        default:
          return []
      }
    },

    finish: () => [...close(), { type: 'finish-step' }, { type: 'finish' }],
    error: errorText => [...close(), { type: 'error', errorText }],
    abort: () => [...close(), { type: 'abort' }]
  }
}
