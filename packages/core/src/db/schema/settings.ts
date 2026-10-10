// server/db/schema/settings.ts
import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core'

// Generic single-row-per-key settings store. The AI config registry uses
// key='ai_config'; the value is the full zod-validated config document.
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})
export type SettingRow = typeof settings.$inferSelect
