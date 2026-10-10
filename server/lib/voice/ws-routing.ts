// Pure mapping from a parsed control frame to what ws.ts should do. Kept out of the handler so
// the protocol is testable without a socket.
import type { AttachmentRef } from '@mymind/core/lib/agent/attachments'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type WsAction =
  | { kind: 'abort' } | { kind: 'attach' } | { kind: 'new' } | { kind: 'clear' } | { kind: 'ignore' }
  | { kind: 'load'; conversationId: string }
  | { kind: 'text'; text: string; speak: boolean; skill?: string; attachments: AttachmentRef[]; conversationId?: string }
  | { kind: 'preset'; presetId: string | null }
  | { kind: 'model'; modelDefId: string | null }
  | { kind: 'approve'; requestId: string; remember: boolean; pattern?: string }
  | { kind: 'deny'; requestId: string }

export function routeFrame(msg: Record<string, unknown>): WsAction {
  switch (msg.type) {
    case 'interrupt': return { kind: 'abort' }
    case 'attach': return { kind: 'attach' }
    case 'new': return { kind: 'new' }
    case 'clear': return { kind: 'clear' }
    case 'load': return typeof msg.conversationId === 'string' && msg.conversationId ? { kind: 'load', conversationId: msg.conversationId } : { kind: 'ignore' }
    case 'preset': return { kind: 'preset', presetId: typeof msg.presetId === 'string' && msg.presetId ? msg.presetId : null }
    case 'model': return { kind: 'model', modelDefId: typeof msg.modelDefId === 'string' ? msg.modelDefId : null }
    case 'approve': return { kind: 'approve', requestId: String(msg.requestId ?? ''), remember: !!msg.remember, ...(typeof msg.pattern === 'string' ? { pattern: msg.pattern } : {}) }
    case 'deny': return { kind: 'deny', requestId: String(msg.requestId ?? '') }
    case 'text': {
      const text = typeof msg.text === 'string' ? msg.text.trim() : ''
      if (!text) return { kind: 'ignore' }
      return {
        kind: 'text', text, speak: typeof msg.speak === 'boolean' ? msg.speak : false,
        ...(typeof msg.skill === 'string' && msg.skill ? { skill: msg.skill } : {}),
        attachments: Array.isArray(msg.attachments) ? (msg.attachments as AttachmentRef[]) : [],
        // The thread the CLIENT is looking at (final review C1). Only a well-formed id is
        // trusted; anything else falls back to the socket's own view.
        ...(typeof msg.conversationId === 'string' && UUID.test(msg.conversationId) ? { conversationId: msg.conversationId } : {})
      }
    }
    // 'profile' / 'execEnabled' frames from old clients land here and are silently ignored —
    // the agent is always fully armed now (single profile; approval gate = safety).
    default: return { kind: 'ignore' }
  }
}
