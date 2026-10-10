import { sql } from 'drizzle-orm'
import { pgTable, uuid, integer, text, timestamp, index } from 'drizzle-orm/pg-core'

export const sessSummaryState = pgTable('sess_summary_state', {
  sessionId: uuid('session_id').primaryKey(),
  lastSummarizedMessageCount: integer('last_summarized_message_count').notNull().default(0),
  lastRun: timestamp('last_run', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull().default('ok'),
  error: text('error'),
  durationMs: integer('duration_ms'),
  model: text('model'),
  summaryChars: integer('summary_chars'),
  titleChars: integer('title_chars'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('sess_summary_state_last_run_idx').on(t.lastRun)
])
export type SessSummaryState = typeof sessSummaryState.$inferSelect
