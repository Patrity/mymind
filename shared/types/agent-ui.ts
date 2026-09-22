// The agent's UI message model: AI SDK UIMessages with our metadata, one custom data part
// (a subagent's nested steps) and dynamic tool parts whose `output` is a ToolEnvelope.
// Shared by the server encoder (server/lib/voice/ui-stream.ts), the client assembler
// (app/lib/agent/turn-stream.ts) and resume (app/lib/agent/to-ui-messages.ts).
import type { UIMessage, UIMessageChunk } from 'ai'
import type { AttachmentRef, MessageUsage } from './conversation'

export type AgentToolKind = 'read' | 'create' | 'destructive'

/** One nested call inside a subagent run. Persisted on the parent tool record with terminal states only. */
export interface SubagentStep {
  callId: string
  name: string
  summary?: string
  state: 'running' | 'done' | 'error'
}

/** A tool part's `output`: the persist-capped result plus the metadata the UI needs. */
export interface ToolEnvelope {
  value: unknown
  summary: string
  undoToken?: string
  kind?: AgentToolKind
}

export interface AgentMessageMetadata {
  createdAt?: string
  usage?: MessageUsage
  /** User messages only — the refs sent with the turn (retry re-sends them). */
  attachments?: AttachmentRef[]
  /** Resume only — the server-computed position among this message's siblings, which is the
   *  ONLY thing the ‹ n/N › pager renders. A live-streamed message is assembled client-side
   *  and carries none, so it degrades to `total: 1` (no pager) until the transcript is
   *  refetched; the page refetches after any turn that created a branch. */
  branch?: { index: number; total: number }
  /** Resume only — every sibling of this message in read order, including it, so
   *  `siblingIds[branch.index - 1] === id`. Only the ACTIVE path is ever fetched, so these
   *  ids are the client's only handle on the branches it is not reading: the pager switches
   *  by picking `siblingIds[index - 1 + dir]`. */
  siblingIds?: string[]
  /** Client-side: stopped, barged in on, or superseded by a newer turn. */
  interrupted?: true
  /** Client-side: the turn ended with an error chunk or the socket dropped. */
  errorText?: string
}

// A type alias (not an interface) so it satisfies the SDK's `UIDataTypes` index signature.
export type AgentDataParts = {
  subagent: { steps: SubagentStep[] }
}

export type AgentUIMessage = UIMessage<AgentMessageMetadata, AgentDataParts>
export type AgentUIPart = AgentUIMessage['parts'][number]
export type AgentUIChunk = UIMessageChunk<AgentMessageMetadata, AgentDataParts>

/** The WS frames that carry the message protocol (audio/state/approval frames are separate). */
export type AgentMessageFrame =
  | { type: 'chunk'; turnId: number; chunk: AgentUIChunk }
  | { type: 'user-message'; turnId: number; message: AgentUIMessage }
