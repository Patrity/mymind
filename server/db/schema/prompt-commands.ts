import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

/** Saved prompt macros surfaced as `/name` in the composer. Client-kind commands are
 *  deliberately NOT here — see shared/types/commands.ts. */
export const promptCommands = pgTable('prompt_commands', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  description: text('description').notNull(),
  template: text('template').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, t => [uniqueIndex('prompt_commands_name_uidx').on(t.name)])

export type PromptCommandRow = typeof promptCommands.$inferSelect
