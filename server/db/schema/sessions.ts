import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { halfvec } from '../types/halfvec'

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  source: text('source').notNull(),
  externalId: text('external_id').notNull(),
  project: text('project'),
  cwd: text('cwd'),
  machineId: text('machine_id'),
  hostname: text('hostname'),
  gitBranch: text('git_branch'),
  gitCommit: text('git_commit'),
  gitRemote: text('git_remote'),
  appVersion: text('app_version'),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  title: text('title'),
  summary: text('summary'),
  messageCount: integer('message_count').notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  toolCount: integer('tool_count').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastActive: timestamp('last_active', { withTimezone: true }).notNull().defaultNow(),
  summaryEmbedding: halfvec(2560, 'summary_embedding'),
  lastEmbeddedAt: timestamp('last_embedded_at', { withTimezone: true }),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`)
}, (t) => [
  uniqueIndex('sessions_source_external_uidx').on(t.source, t.externalId),
  index('sessions_machine_idx').on(t.machineId)
])

export type Session = typeof sessions.$inferSelect
