// server/lib/voice/turn-persist.ts
//
// Turns a live turn's added AgentMessages ([user] or [user, assistant]) into the
// appendMessages payload. Pulled out of server/api/voice/ws.ts's `run()` closure into an
// importable pure function — defineWebSocketHandler needs a real crossws upgrade to exercise
// directly, so anything built inline there is untestable without one. This is the seam tests
// hit instead.
import type { AgentMessage } from '../agent/run'
import { messageText } from '../agent/run'
import { withoutAttachmentMarkers, type AttachmentRef } from '../agent/attachments'
import type { NewConvMessage } from '../../services/conversations'

export interface TurnPersistContext {
  /** How the USER's half of the turn arrived. */
  inputModality: 'text' | 'voice'
  /** Whether this turn was spoken (TTS) — the assistant half's modality follows this. */
  speakFlag: boolean
  attachments: AttachmentRef[]
  reasoning: string
  usage: NewConvMessage['usage']
}

/** Builds the appendMessages payload for one turn's added messages. */
export function buildTurnPersistPayload(added: AgentMessage[], ctx: TurnPersistContext): NewConvMessage[] {
  return added.map(m => ({
    role: m.role as 'user' | 'assistant',
    // Attachment markers are a live-turn signal only. Persisting one makes it durable:
    // it is replayed on every future turn and, once flattened into `content`, is no
    // longer a separate part the resume-path filter can remove.
    content: messageText(withoutAttachmentMarkers(m.content)),
    modality: m.role === 'user' ? ctx.inputModality : (ctx.speakFlag ? 'voice' : 'text'),
    toolCalls: m.role === 'assistant' && m.toolRecords?.length ? m.toolRecords : null,
    reasoning: m.role === 'assistant' ? (ctx.reasoning || null) : null,
    attachments: m.role === 'user' ? ctx.attachments : null,
    usage: m.role === 'assistant' ? ctx.usage : null
  }))
}
