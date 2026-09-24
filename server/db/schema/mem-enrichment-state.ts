import { pgTable, uuid, integer, text, timestamp, primaryKey } from 'drizzle-orm/pg-core'

export const memEnrichmentState = pgTable('mem_enrichment_state', {
  /** 'session' = a Claude Code transcript; 'conversation' = a Bridget thread. */
  sourceKind: text('source_kind').notNull().default('session'),
  sourceId: uuid('source_id').notNull(),
  lastEnrichedMessageCount: integer('last_enriched_message_count').notNull().default(0),
  lastRun: timestamp('last_run', { withTimezone: true }),
  status: text('status'),
  error: text('error')
}, t => [primaryKey({ columns: [t.sourceKind, t.sourceId] })])
