import { pgTable, text, uuid, real, integer, timestamp, primaryKey, index } from 'drizzle-orm/pg-core'

export const graphLayout = pgTable('graph_layout', {
  sourceType: text('source_type').notNull(), // memory|document|image|session|project
  sourceId: uuid('source_id').notNull(),
  x: real('x').notNull(),
  y: real('y').notNull(),
  z: real('z').notNull(),
  degree: integer('degree').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.sourceType, t.sourceId] }),
  byType: index('graph_layout_type_idx').on(t.sourceType),
}))

export type GraphLayout = typeof graphLayout.$inferSelect
