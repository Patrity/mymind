import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { halfvec } from '../types/halfvec'

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  title: text('title'),
  summary: text('summary'),
  projectId: uuid('project_id'),
  messageCount: integer('message_count').notNull().default(0),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  // Reserved for a future summarization worker (keyword search ships first).
  summaryEmbedding: halfvec(2560, 'summary_embedding'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('conversations_last_message_idx').on(t.lastMessageAt),
  // keyword search over titles (pg_trgm already enabled in this DB)
  index('conversations_title_trgm').using('gin', sql`${t.title} gin_trgm_ops`)
])

export const conversationMessages = pgTable('conversation_messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  // Tree-capable edge; populated LINEARLY this cycle (parent = prior turn). Branching
  // (active-leaf/path-walking + fork UI) is deferred — see the spec.
  parentId: uuid('parent_id'),
  role: text('role').notNull(),                 // 'user' | 'assistant'
  content: text('content').notNull().default(''),
  modality: text('modality').notNull(),         // 'voice' | 'text'
  toolCalls: jsonb('tool_calls'),               // [{ name, summary, undoToken? }] for assistant turns
  reasoning: text('reasoning'),                 // assistant thinking; display/storage only, NEVER sent back to the model
  attachments: jsonb('attachments'),            // [{ id, kind, mime, name? }] for user turns (Task 5 populates)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('conversation_messages_convo_idx').on(t.conversationId, t.createdAt),
  index('conversation_messages_content_trgm').using('gin', sql`${t.content} gin_trgm_ops`)
])

export type Conversation = typeof conversations.$inferSelect
export type ConversationMessage = typeof conversationMessages.$inferSelect
