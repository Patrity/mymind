import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid('session_id').notNull(),
  role: text('role'),
  content: text('content').notNull().default(''),
  externalUuid: text('external_uuid'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('messages_session_idx').on(t.sessionId),
  uniqueIndex('messages_session_extuuid_uidx').on(t.sessionId, t.externalUuid)
])

export type Message = typeof messages.$inferSelect
