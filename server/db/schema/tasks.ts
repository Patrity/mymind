import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core'

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('todo'),      // todo | in_progress | completed | blocked
  priority: text('priority').notNull().default('low'),   // low | medium | high
  dueDate: timestamp('due_date', { withTimezone: true }),
  project: text('project'),                               // soft ref projects.slug
  order: integer('order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (t) => [
  index('tasks_status_idx').on(t.status),
  index('tasks_project_idx').on(t.project)
])

export type Task = typeof tasks.$inferSelect
