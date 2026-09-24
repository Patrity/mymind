import { pgTable, uuid, integer, text, timestamp, primaryKey } from 'drizzle-orm/pg-core'

export const memEnrichmentState = pgTable('mem_enrichment_state', {
  /** 'session' = a Claude Code transcript; 'conversation' = a Bridget thread. */
  sourceKind: text('source_kind').notNull().default('session'),
  sourceId: uuid('source_id').notNull(),
  lastEnrichedMessageCount: integer('last_enriched_message_count').notNull().default(0),
  lastRun: timestamp('last_run', { withTimezone: true }),
  status: text('status'),
  error: text('error')
// The live constraint (on dev, and on any fresh DB replaying 0049) is named
// "mem_enrichment_state_pkey" — Postgres's default <table>_pkey naming, since the hand-written
// migration adds it via a bare `ADD PRIMARY KEY` rather than drizzle's own naming convention.
// Naming it explicitly here keeps this tracked name in sync with reality; leaving it implicit
// would make drizzle track "mem_enrichment_state_source_kind_source_id_pk" (its own default for
// a composite key declared this way), which exists on no database and would make a future
// `db:generate` emit a DROP CONSTRAINT for a name nothing has.
}, t => [primaryKey({ name: 'mem_enrichment_state_pkey', columns: [t.sourceKind, t.sourceId] })])
