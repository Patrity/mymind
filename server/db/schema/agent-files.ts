import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core'

export const agentFiles = pgTable('agent_files', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  storageKey: text('storage_key').notNull(),
  mime: text('mime').notNull(),
  name: text('name'),
  size: integer('size').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

export type AgentFile = typeof agentFiles.$inferSelect
