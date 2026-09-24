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
  /** Leaf of the branch currently displayed. A thread is a tree (see parent_id); this names
   *  which path through it is active. Nullable only as a fallback: null → flat read. */
  activeLeafId: uuid('active_leaf_id'),
  /** `/clear` boundary. The MODEL reads only messages at or after this; the UI still shows
   *  everything and renders a divider here, so the two readers differ VISIBLY rather than
   *  silently (cycle 68's invariant is that they must never disagree unnoticed). */
  contextEpochAt: timestamp('context_epoch_at', { withTimezone: true }),
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
  // Tree edge. Branching is LIVE as of cycle 68: fork/edit/regenerate append a child to a
  // chosen parent, and conversations.active_leaf_id names the path being read.
  parentId: uuid('parent_id'),
  role: text('role').notNull(),                 // 'user' | 'assistant'
  content: text('content').notNull().default(''),
  modality: text('modality').notNull(),         // 'voice' | 'text'
  // AgentToolRecord[] for assistant turns (server/lib/agent/tool-history.ts):
  // [{ callId, name, kind, args, result, summary, undoToken?, textOffset }]. Untyped jsonb,
  // written additively — legacy rows still hold only { name, summary, undoToken? } and
  // degrade to shape-only (chip renders, contributes nothing to model history).
  toolCalls: jsonb('tool_calls'),
  reasoning: text('reasoning'),                 // assistant thinking; display/storage only, NEVER sent back to the model
  attachments: jsonb('attachments'),            // [{ id, kind, mime, name? }] for user turns (Task 5 populates)
  // Per-turn model usage from streamText, for the transcript's token readout.
  // Nullable and additive: messages written before this column omit the count
  // rather than showing a zero. { inputTokens, outputTokens, totalTokens }.
  usage: jsonb('usage'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('conversation_messages_convo_idx').on(t.conversationId, t.createdAt),
  index('conversation_messages_content_trgm').using('gin', sql`${t.content} gin_trgm_ops`)
])

export type Conversation = typeof conversations.$inferSelect
export type ConversationMessage = typeof conversationMessages.$inferSelect
