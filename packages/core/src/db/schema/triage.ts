import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, real, timestamp, index } from 'drizzle-orm/pg-core'

// One row per triage action actually EXECUTED (auto-applied or approved).
// This is what makes reversal work past registerUndo's 10-minute TTL, and it is
// the audit trail for "why is this task on my board" — without it an auto-applied
// action is indistinguishable from one created by hand.
export const triageActions = pgTable('triage_actions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  docId: uuid('doc_id').notNull(),
  kind: text('kind').notNull(),                       // TriageKind
  entityType: text('entity_type').notNull(),          // 'task' | 'memory' | 'document'
  entityId: uuid('entity_id'),                        // null if the actuator produced nothing
  confidence: real('confidence').notNull(),
  autoApplied: boolean('auto_applied').notNull(),
  payload: jsonb('payload').notNull(),                // the TriageAction, for reversal + display
  revertedAt: timestamp('reverted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => ({
  createdAtIdx: index('triage_actions_created_at_idx').on(t.createdAt),
  docIdx: index('triage_actions_doc_idx').on(t.docId)
}))

export type TriageActionRow = typeof triageActions.$inferSelect
