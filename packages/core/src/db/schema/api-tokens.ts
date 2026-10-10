import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  lastFour: text('last_four'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true })
})
export type ApiToken = typeof apiTokens.$inferSelect
