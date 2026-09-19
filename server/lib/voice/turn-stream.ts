// One turn's frames on the voice socket. Owns the emission-ORDER rules so ws.ts stays thin
// and so they are testable without a crossws harness:
//   - every message frame carries the turn's id (the client drops a superseded turn's frames);
//   - `finish` is sent only after handleTurn returns — the orchestrator appends image embeds
//     AFTER the speech pipeline drains, and those must land inside the message;
//   - no chunk is sent after finish/error/abort — except that error() always sends the
//     legacy error + idle frames (a persistence failure lands after finish()).
import { randomUUID } from 'node:crypto'
import type { VoiceEvent } from './orchestrator'
import { createUIChunkEncoder } from './ui-stream'
import type { AgentMessageFrame, AgentUIChunk, AgentUIMessage } from '../../../shared/types/agent-ui'
import type { AttachmentRef } from '../../../shared/types/conversation'
import { attachmentToFilePart } from '../../../shared/utils/agent-ui'

export interface TurnStream {
  emit(e: VoiceEvent): void
  finish(): void
  error(message: string): void
  abort(): void
}

export interface TurnStreamOptions {
  turnId: number
  send: (data: string | Uint8Array) => void
  attachments?: AttachmentRef[]
  now?: () => Date
  newId?: () => string
}

export function createTurnStream(o: TurnStreamOptions): TurnStream {
  const now = o.now ?? (() => new Date())
  const newId = o.newId ?? randomUUID
  const encoder = createUIChunkEncoder(newId())
  let started = false
  let closed = false

  const json = (frame: unknown) => o.send(JSON.stringify(frame))
  const sendChunks = (chunks: AgentUIChunk[]) => {
    for (const chunk of chunks) json({ type: 'chunk', turnId: o.turnId, chunk } satisfies AgentMessageFrame)
  }

  return {
    emit(e) {
      if (closed) return
      switch (e.type) {
        case 'audio': o.send(e.bytes); return
        case 'audio-begin': json({ ...e, turnId: o.turnId }); return
        case 'audio-end':
        case 'state': json(e); return
        case 'transcript':
          if (e.role === 'user') {
            const attachments = o.attachments ?? []
            const message: AgentUIMessage = {
              id: newId(),
              role: 'user',
              parts: [{ type: 'text', text: e.text }, ...attachments.map(attachmentToFilePart)],
              metadata: { createdAt: now().toISOString(), ...(attachments.length ? { attachments } : {}) }
            }
            json({ type: 'user-message', turnId: o.turnId, message } satisfies AgentMessageFrame)
            return
          }
          break
      }
      const chunks = encoder.encode(e)
      if (!chunks.length) return
      if (!started) { started = true; sendChunks(encoder.start(now().toISOString())) }
      sendChunks(chunks)
    },
    finish() {
      if (closed) return
      closed = true
      if (started) sendChunks(encoder.finish())
    },
    error(message) {
      // Only the error CHUNK is gated on the message still being open. The legacy error +
      // idle frames ALWAYS go out: ws.ts finishes the message BEFORE persisting, so a
      // createConversation/appendMessages failure arrives here after finish() — and the
      // page's alert (and its return to idle) must still fire.
      if (!closed && started) sendChunks(encoder.error(message))
      closed = true
      json({ type: 'error', message })
      json({ type: 'state', state: 'idle' })
    },
    abort() {
      if (closed) return
      closed = true
      if (started) sendChunks(encoder.abort())
    }
  }
}
