import { and, desc, eq, or, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { conversations, conversationMessages } from '../db/schema'
import type { ConversationDTO, ConversationMessageDTO, ConversationListItem } from '../../shared/types/conversation'

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
  toolCalls?: { name: string; summary: string; undoToken?: string }[] | null
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

function msgToDTO(r: typeof conversationMessages.$inferSelect): ConversationMessageDTO {
  return {
    id: r.id,
    role: r.role as 'user' | 'assistant',
    content: r.content,
    modality: r.modality as 'voice' | 'text',
    toolCalls: (r.toolCalls as { name: string; summary: string; undoToken?: string }[] | null) ?? null,
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
        toolCalls: msg.toolCalls ?? null
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

export async function getAgentHistory(
  id: string
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const rows = await useDb()
    .select({ role: conversationMessages.role, content: conversationMessages.content })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, id))
    .orderBy(conversationMessages.createdAt)

  return rows.map(r => ({ role: r.role as 'user' | 'assistant', content: r.content }))
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
