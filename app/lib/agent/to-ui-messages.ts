// Persisted conversation messages → AgentUIMessage[], for resume. One persisted assistant row
// is ONE message whose parts interleave text and tools at each record's textOffset — the
// offset is recorded server-side against the SANITIZED text (image-embed.ts sanitizedOffset),
// so slicing the persisted content at it reproduces the live stream's order.
import type { ConversationMessageDTO, ToolCallRecordDTO } from '~~/shared/types/conversation'
import type { AgentUIMessage, AgentUIPart, AgentMessageMetadata } from '~~/shared/types/agent-ui'
import { toolOutcome, toolEnvelope, attachmentToFilePart } from '~~/shared/utils/agent-ui'

// `branch`/`siblingIds` are carried through deliberately: the server has populated them on
// ConversationMessageDTO since Task 3, but this Pick used to drop them, so the branch pager
// could never render anything however correct the server was. They are Partial like the rest —
// a caller constructing a ResumeMessage by hand (the tests, mostly) need not supply them, and
// an absent `branch` reads as "lone trunk message", the same default msgToDTO applies.
export type ResumeMessage = Pick<ConversationMessageDTO, 'id' | 'role' | 'content'>
  & Partial<Pick<ConversationMessageDTO, 'toolCalls' | 'reasoning' | 'attachments' | 'usage' | 'createdAt' | 'branch' | 'siblingIds'>>

const textPart = (text: string): AgentUIPart => ({ type: 'text', text, state: 'done' })

function recordParts(m: ResumeMessage, t: ToolCallRecordDTO, i: number): AgentUIPart[] {
  const toolCallId = t.callId || `${m.id}-tool-${i}`
  const base = { type: 'dynamic-tool' as const, toolName: t.name, toolCallId, input: t.args ?? {} }
  const outcome = toolOutcome(t.result)
  const tool: AgentUIPart = outcome.state === 'denied'
    ? { ...base, state: 'output-denied', approval: { id: toolCallId, approved: false } }
    : outcome.state === 'error'
      ? { ...base, state: 'output-error', errorText: outcome.errorText }
      : { ...base, state: 'output-available', output: toolEnvelope({ result: t.result, summary: t.summary, undoToken: t.undoToken, kind: t.kind }) }
  return t.steps?.length
    ? [tool, { type: 'data-subagent', id: toolCallId, data: { steps: t.steps } }]
    : [tool]
}

export function toUIMessages(messages: ResumeMessage[]): AgentUIMessage[] {
  return messages.map((m): AgentUIMessage => {
    const metadata: AgentMessageMetadata = {
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
      ...(m.usage ? { usage: m.usage } : {}),
      ...(m.branch ? { branch: m.branch } : {}),
      ...(m.siblingIds ? { siblingIds: m.siblingIds } : {})
    }
    if (m.role === 'user') {
      const attachments = m.attachments ?? []
      return {
        id: m.id,
        role: 'user',
        parts: [...(m.content ? [{ type: 'text' as const, text: m.content }] : []), ...attachments.map(attachmentToFilePart)],
        metadata: { ...metadata, ...(attachments.length ? { attachments } : {}) }
      }
    }

    const parts: AgentUIPart[] = m.reasoning ? [{ type: 'reasoning', text: m.reasoning, state: 'done' }] : []
    // Malformed jsonb (a null/primitive element) must not throw — same tolerance as rowToAgentMessage.
    const records = (m.toolCalls ?? []).filter((t): t is ToolCallRecordDTO => !!t && typeof t === 'object')
    // All-or-nothing: interleave only when EVERY record has an offset; otherwise legacy tools-first.
    const allOffset = records.length > 0 && records.every(t => typeof t.textOffset === 'number')
    if (!allOffset) {
      records.forEach((t, i) => parts.push(...recordParts(m, t, i)))
      if (m.content) parts.push(textPart(m.content))
    } else {
      let cursor = 0
      records.forEach((t, i) => {
        const at = Math.min(Math.max(t.textOffset!, 0), m.content.length)
        if (at > cursor) parts.push(textPart(m.content.slice(cursor, at)))
        parts.push(...recordParts(m, t, i))
        // Never walk backwards: sanitizedOffset is not monotonic.
        cursor = Math.max(cursor, at)
      })
      const trailing = m.content.slice(cursor)
      if (trailing) parts.push(textPart(trailing))
    }
    return { id: m.id, role: 'assistant', parts, metadata }
  })
}
