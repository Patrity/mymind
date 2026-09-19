import type { SubagentStep } from './agent-ui'

export interface AttachmentRef {
  id: string
  kind: 'image' | 'file'
  mime: string
  name?: string
}

/** Legacy rows carry only name/summary/undoToken; every field added later is optional. */
export interface ToolCallRecordDTO {
  name: string
  summary: string
  undoToken?: string
  callId?: string
  kind?: 'read' | 'create' | 'destructive'
  args?: Record<string, unknown>
  result?: unknown
  textOffset?: number
  /** A subagent's nested calls (terminal states only). Display-only — never sent to the model. */
  steps?: SubagentStep[]
}

export interface MessageUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** The context in use after this call: the LAST model step's input + output tokens. */
  contextTokens?: number
  /** The registry model that actually produced the stream (failover-aware). */
  modelDefId?: string
}

export interface ConversationMessageDTO {
  id: string
  role: 'user' | 'assistant'
  content: string
  modality: 'voice' | 'text'
  toolCalls: ToolCallRecordDTO[] | null
  reasoning: string | null
  attachments: AttachmentRef[] | null
  usage: MessageUsage | null
  createdAt: string
}
export interface ConversationDTO {
  id: string
  title: string | null
  projectId: string | null
  messageCount: number
  lastMessageAt: string | null
  createdAt: string
}
export interface ConversationListItem extends ConversationDTO {
  snippet: string | null   // first/last message preview for the list/slideover
}
