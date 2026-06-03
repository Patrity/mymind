import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  source: text('source').notNull(),
  externalId: text('external_id').notNull(),
  project: text('project'),
  cwd: text('cwd'),
  title: text('title'),
  summary: text('summary'),
  messageCount: integer('message_count').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastActive: timestamp('last_active', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`)
}, (t) => [
  uniqueIndex('sessions_source_external_uidx').on(t.source, t.externalId)
])

export type Session = typeof sessions.$inferSelect
