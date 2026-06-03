import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, real, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { halfvec } from '../types/halfvec'

export const memories = pgTable('memories', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  scope: text('scope').notNull().default('user'),          // user | agent | world
  content: text('content').notNull(),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  source: text('source'),
  embedding: halfvec(2560),
  contentHash: text('content_hash').notNull(),
  confidence: real('confidence'),
  evidence: jsonb('evidence').notNull().default(sql`'[]'::jsonb`),
  project: text('project'),
  sessionId: uuid('session_id'),
  enrichedAt: timestamp('enriched_at', { withTimezone: true }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true })
}, (t) => [
  index('memories_scope_idx').on(t.scope),
  index('memories_tags_gin').using('gin', t.tags),
  uniqueIndex('memories_content_hash_live_uidx').on(t.contentHash).where(sql`${t.archivedAt} is null`)
])

export type Memory = typeof memories.$inferSelect
