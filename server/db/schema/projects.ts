import { pgTable, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const projects = pgTable('projects', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export type Project = typeof projects.$inferSelect
