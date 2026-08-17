import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'

// A board column. `kind` is what CODE reads; `name` is user-facing and never switched on.
// `color` is one of the app's semantic aliases (primary|secondary|success|info|warning|error|
// neutral) — it feeds both the board tint and this task's status badge app-wide.
export const taskColumns = pgTable('task_columns', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  kind: text('kind').notNull(),              // open | started | done | blocked
  color: text('color').notNull().default('neutral'),
  position: integer('position').notNull().default(0),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => [
  index('task_columns_position_idx').on(t.position),
  // The compat seam resolves status -> "the default column of this kind". Exactly one per
  // kind, enforced here rather than in application code: if a kind ever loses its default,
  // create_task(status=...) has nothing to resolve to and fails at runtime.
  uniqueIndex('task_columns_one_default_per_kind').on(t.kind).where(sql`is_default`)
])

export type TaskColumn = typeof taskColumns.$inferSelect
