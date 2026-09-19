// app/lib/agent/retry.ts
//
// Pure "walk back to the preceding user turn and truncate" logic behind retryTurn. Replaces
// in place — it does NOT fork. The user turn is re-sent through sendText, whose server echo
// (a user-message frame) re-creates it, so it is removed here too.
import type { AgentUIMessage } from '~~/shared/types/agent-ui'
import type { AttachmentRef } from '~~/shared/types/conversation'

export interface RetryPlan {
  messages: AgentUIMessage[]
  text: string
  attachments: AttachmentRef[]
}

export function truncateForRetry(messages: AgentUIMessage[], messageId: string): RetryPlan | null {
  const i = messages.findIndex(m => m.id === messageId)
  if (i < 0) return null
  let j = i - 1
  while (j >= 0 && messages[j]!.role !== 'user') j--
  if (j < 0) return null
  const user = messages[j]!
  const text = user.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')
  return { messages: messages.slice(0, j), text, attachments: user.metadata?.attachments ?? [] }
}
