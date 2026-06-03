import { pgTable, uuid, integer, text, timestamp } from 'drizzle-orm/pg-core'

export const memEnrichmentState = pgTable('mem_enrichment_state', {
  sessionId: uuid('session_id').primaryKey(),
  lastEnrichedMessageCount: integer('last_enriched_message_count').notNull().default(0),
  lastRun: timestamp('last_run', { withTimezone: true }),
  status: text('status'),
  error: text('error')
})
