import { and, desc, eq, or, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { conversations, conversationMessages } from '../db/schema'
import type { ConversationDTO, ConversationMessageDTO, ConversationListItem, AttachmentRef, ToolCallRecordDTO, MessageUsage } from '../../shared/types/conversation'
import type { AgentMessage, AgentContentPart } from '../lib/agent/run'
import type { AgentToolRecord } from '../lib/agent/tool-history'
import { TOOL_HISTORY_WINDOW } from '../lib/agent/tool-history'
import { buildUserMessageParts, withoutAttachmentMarkers } from '../lib/agent/attachments'
import { getImageBytes } from './images'
import { getFileBytes } from './files'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function deriveTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return 'New conversation'
  return t.length <= 60 ? t : t.slice(0, 59).trimEnd() + '…'
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NewConvMessage {
  role: 'user' | 'assistant'
  content: string
  modality: 'voice' | 'text'
  toolCalls?: ToolCallRecordDTO[] | null
  reasoning?: string | null
  attachments?: AttachmentRef[] | null
  // Assistant-turn token usage from streamText, for the transcript's token readout.
  usage?: MessageUsage | null
}

// ---------------------------------------------------------------------------
// DTO mappers
// ---------------------------------------------------------------------------

function convToDTO(r: typeof conversations.$inferSelect): ConversationDTO {
  return {
    id: r.id,
    title: r.title ?? null,
    projectId: r.projectId ?? null,
    messageCount: r.messageCount,
    lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
    createdAt: r.createdAt.toISOString()
  }
}

export function msgToDTO(r: typeof conversationMessages.$inferSelect): ConversationMessageDTO {
  return {
    id: r.id,
    role: r.role as 'user' | 'assistant',
    content: r.content,
    modality: r.modality as 'voice' | 'text',
    toolCalls: (r.toolCalls as ToolCallRecordDTO[] | null) ?? null,
    reasoning: r.reasoning ?? null,
    attachments: (r.attachments as AttachmentRef[] | null) ?? null,
    usage: (r.usage as MessageUsage | null) ?? null,
    createdAt: r.createdAt.toISOString()
  }
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export async function createConversation(
  input?: { title?: string | null; projectId?: string | null }
): Promise<ConversationDTO> {
  const [row] = await useDb()
    .insert(conversations)
    .values({
      title: input?.title ?? null,
      projectId: input?.projectId ?? null
    })
    .returning()
  return convToDTO(row!)
}

export async function appendMessages(
  conversationId: string,
  msgs: NewConvMessage[]
): Promise<void> {
  if (!msgs.length) return

  const db = useDb()

  // Find the current last message id to chain from
  const [lastMsg] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1)

  let prevId: string | null = lastMsg?.id ?? null

  // Insert each message in order, chaining parentId linearly
  for (const msg of msgs) {
    const [inserted] = await db
      .insert(conversationMessages)
      .values({
        conversationId,
        parentId: prevId,
        role: msg.role,
        content: msg.content,
        modality: msg.modality,
        toolCalls: msg.toolCalls ?? null,
        reasoning: msg.reasoning ?? null,
        attachments: msg.attachments ?? null,
        usage: msg.usage ?? null
      })
      .returning({ id: conversationMessages.id })
    prevId = inserted!.id
  }

  // Bump conversation stats
  const now = new Date()
  await db
    .update(conversations)
    .set({
      messageCount: sql`${conversations.messageCount} + ${msgs.length}`,
      lastMessageAt: now,
      updatedAt: now
    })
    .where(eq(conversations.id, conversationId))
}

export async function getConversation(
  id: string
): Promise<{ conversation: ConversationDTO; messages: ConversationMessageDTO[] } | null> {
  const db = useDb()

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1)

  if (!conv) return null

  const msgs = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, id))
    .orderBy(conversationMessages.createdAt)

  return {
    conversation: convToDTO(conv),
    messages: msgs.map(msgToDTO)
  }
}

/** Row → AgentMessage. Never throws: a malformed tool_calls jsonb yields no records. */
export function rowToAgentMessage(
  r: { role: string; content: string; toolCalls: unknown; attachments: unknown }
): AgentMessage {
  const base = { role: r.role as 'user' | 'assistant', content: r.content }
  if (r.role !== 'assistant' || !Array.isArray(r.toolCalls) || !r.toolCalls.length) return base as AgentMessage
  return { ...base, role: 'assistant', toolRecords: r.toolCalls as AgentToolRecord[] } as AgentMessage
}

/**
 * `buildUserMessageParts` (live-turn code, unmodified here) degrades a single failed read to
 * an `[attachment unavailable…]` text note. That's fine for a ONE-SHOT live turn, but
 * `hydrateAttachments` re-runs it on every `getAgentHistory` call — a durably-missing blob
 * would otherwise re-inject that note into replayed history on every resume, which is the
 * same repeating-marker-in-history shape as the `[image]` imitation bug. Strip it here, on
 * the resume path only, so a failed within-window read degrades the same way an
 * out-of-window turn does: silently. If nothing usable survives the strip (no text, no
 * other attachment), fall back to the plain text content rather than an empty parts array.
 */
function stripUnavailableMarkers(
  content: string | AgentContentPart[],
  fallbackText: string
): string | AgentContentPart[] {
  if (typeof content === 'string') return content
  const filtered = withoutAttachmentMarkers(content) as AgentContentPart[]
  return filtered.length ? filtered : fallbackText
}

/**
 * Re-attach image/file bytes to the most recent user turns so a resumed agent can still SEE
 * them. Older turns degrade to plain text with NO placeholder — a marker is exactly the
 * artifact cycle 39 removed, and reintroducing one here would re-open the imitation bug.
 */
export async function hydrateAttachments(
  msgs: AgentMessage[],
  rows: { role: string; attachments: unknown }[],
  readBytes: (a: AttachmentRef) => Promise<{ bytes: Buffer; mime: string } | null>
): Promise<AgentMessage[]> {
  const withAttachments = rows
    .map((r, i) => (r.role === 'user' && Array.isArray(r.attachments) && r.attachments.length ? i : -1))
    .filter(i => i >= 0)
  const keep = new Set(withAttachments.slice(-TOOL_HISTORY_WINDOW))

  return Promise.all(msgs.map(async (m, i) => {
    if (!keep.has(i)) return m
    const refs = rows[i]!.attachments as AttachmentRef[]
    // Clean the STORED text before it re-enters: rows written before markers were stripped at
    // the persist boundary carry them inline, where they are no longer their own part and the
    // part-level filter below can never reach them. This also keeps `fallbackText` marker-free,
    // so the empty-parts fallback cannot hand a marker straight back.
    const text = withoutAttachmentMarkers(m.content as string) as string
    const built = await buildUserMessageParts(text, refs, readBytes)
    return { ...m, content: stripUnavailableMarkers(built, text) }
  }))
}

export async function getAgentHistory(id: string): Promise<AgentMessage[]> {
  const rows = await useDb()
    .select({
      role: conversationMessages.role,
      content: conversationMessages.content,
      toolCalls: conversationMessages.toolCalls,
      attachments: conversationMessages.attachments
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, id))
    .orderBy(conversationMessages.createdAt)

  const msgs = rows.map(rowToAgentMessage)

  // A missing blob, an unreadable file, or any other thrown error must never break resume —
  // fall back to the un-hydrated (plain-text) messages rather than propagating.
  try {
    return await hydrateAttachments(
      msgs,
      rows,
      (a: AttachmentRef) => (a.kind === 'image' ? getImageBytes(a.id) : getFileBytes(a.id))
    )
  } catch {
    return msgs
  }
}

export async function listConversations(
  opts?: { q?: string }
): Promise<ConversationListItem[]> {
  const db = useDb()
  const q = opts?.q?.trim()

  const whereClause = q
    ? or(
        sql`${conversations.title} ilike ${'%' + q + '%'}`,
        sql`${conversations.id} in (select conversation_id from ${conversationMessages} where ${conversationMessages.content} ilike ${'%' + q + '%'})`
      )
    : undefined

  const rows = await db
    .select()
    .from(conversations)
    .where(whereClause)
    .orderBy(sql`${conversations.lastMessageAt} desc nulls last`)
    .limit(50)

  return rows.map(r => ({
    ...convToDTO(r),
    snippet: null
  }))
}

export async function deleteConversation(id: string): Promise<void> {
  // cascade delete on conversation_messages is set via FK onDelete: 'cascade'
  await useDb()
    .delete(conversations)
    .where(eq(conversations.id, id))
}
