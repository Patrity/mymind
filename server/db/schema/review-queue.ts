import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const reviewQueue = pgTable('review_queue', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  /** @deprecated superseded by (target_kind, target_id). Nullable, no longer written;
   *  the DROP is deferred to a later cycle — prod is live and it is the only
   *  irreversible step this migration could take. */
  docId: uuid('doc_id'),
  targetKind: text('target_kind').notNull().default('document'),
  targetId: uuid('target_id').notNull(),
  kind: text('kind').notNull().default('enrichment'),
  proposed: jsonb('proposed').notNull(),
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true })
}, (t) => ({
  statusIdx: index('review_queue_status_idx').on(t.status),
  onePendingPerTarget: uniqueIndex('review_queue_one_pending_per_target')
    .on(t.targetKind, t.targetId).where(sql`status = 'pending'`)
}))

export type ReviewItem = typeof reviewQueue.$inferSelect
