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
  /** When the turn started, ISO. Timing is stored here rather than in its own column
   *  because usage is already the per-message jsonb for model/token facts. */
  startedAt?: string
  /** Start → first assistant token. */
  ttftMs?: number
  /** Start → turn finish. */
  durationMs?: number
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
  parentId: string | null
  /** 1-based position among siblings and the sibling count; total 1 means no pager. */
  branch: { index: number; total: number }
  /** Every sibling of this message (messages sharing its parent), in creation order, INCLUDING
   *  this one — so `siblingIds[branch.index - 1] === id`. The client needs these to switch
   *  branches: only the active path is fetched, so it cannot discover a sibling any other way.
   *  Its only consumer arrives in a later task; it is populated here so one task owns the DTO. */
  siblingIds: string[]
}
export interface ConversationDTO {
  id: string
  title: string | null
  projectId: string | null
  messageCount: number
  lastMessageAt: string | null
  createdAt: string
  /**
   * The `/clear` boundary: messages created before this are still stored and still shown,
   * but the model cannot see them (`getAgentHistory` filters on it).
   *
   * It has to reach the client or the divider only exists for the lifetime of the tab that
   * ran `/clear` — after a reload the user reads pre-clear messages Bridget has no idea
   * about, with nothing marking where her memory starts. That silent divergence is the exact
   * thing the divider exists to prevent. Null when the conversation has never been cleared.
   */
  contextEpochAt: string | null
}
export interface ConversationListItem extends ConversationDTO {
  snippet: string | null   // first/last message preview for the list/slideover
}
