import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// Persisted, editable allowlist of shell-command patterns Tony has chosen to
// "always allow" for a dangerous agent tool (exec today; ssh/file-edit later).
export const execApprovals = pgTable('exec_approvals', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  pattern: text('pattern').notNull(),        // glob, e.g. "git *" — anchored + chaining-safe at match time
  tool: text('tool').notNull().default('exec'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true })
}, (t) => [
  uniqueIndex('exec_approvals_tool_pattern_idx').on(t.tool, t.pattern)
])

export type ExecApproval = typeof execApprovals.$inferSelect
