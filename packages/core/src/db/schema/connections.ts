import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { account } from './auth'

/** Cycle 79: one row per linked Google account (better-auth `account` row, providerId 'google').
 *  Tokens stay in `account` (encrypted); this holds MyMind's label + health for each. */
export const connections = pgTable('connections', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  accountId: text('account_id').notNull().unique().references(() => account.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  email: text('email').notNull(),
  status: text('status').notNull().default('ok').$type<'ok' | 'needs_reconnect'>(),
  lastError: text('last_error'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, t => [uniqueIndex('connections_provider_label').on(t.provider, t.label)])

export type ConnectionRow = typeof connections.$inferSelect
