import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { halfvec } from '../types/halfvec'

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid('session_id').notNull(),
  role: text('role'),
  content: text('content').notNull().default(''),
  externalUuid: text('external_uuid'),
  parentUuid: text('parent_uuid'),
  thinking: text('thinking'),
  model: text('model'),
  stopReason: text('stop_reason'),
  requestId: text('request_id'),
  isSidechain: boolean('is_sidechain').notNull().default(false),
  usage: jsonb('usage'),
  embedding: halfvec(2560),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('messages_session_idx').on(t.sessionId),
  uniqueIndex('messages_session_extuuid_uidx').on(t.sessionId, t.externalUuid)
])

export type Message = typeof messages.$inferSelect
