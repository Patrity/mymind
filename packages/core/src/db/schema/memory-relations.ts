import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, real, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const memoryRelations = pgTable('memory_relations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  fromId: uuid('from_id').notNull(),   // the newer / superseding memory
  toId: uuid('to_id').notNull(),       // the older / affected memory
  type: text('type').notNull(),        // supersedes | contradicts | duplicate-of
  confidence: real('confidence'),
  status: text('status').notNull().default('active'), // active | resolved
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true })
}, (t) => [
  index('memory_relations_from_idx').on(t.fromId),
  index('memory_relations_to_idx').on(t.toId),
  index('memory_relations_type_idx').on(t.type),
  uniqueIndex('memory_relations_edge_uidx').on(t.fromId, t.toId, t.type)
])
export type MemoryRelation = typeof memoryRelations.$inferSelect
