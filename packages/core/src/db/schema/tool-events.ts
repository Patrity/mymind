import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const toolEvents = pgTable('tool_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid('session_id').notNull(),
  messageId: uuid('message_id'),
  toolName: text('tool_name').notNull(),
  args: jsonb('args'),
  result: jsonb('result'),
  exitStatus: text('exit_status'),
  phase: text('phase').notNull().default('completed'),
  toolUseId: text('tool_use_id'),
  isSidechain: boolean('is_sidechain').notNull().default(false),
  callerType: text('caller_type'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('tool_events_session_idx').on(t.sessionId),
  index('tool_events_tool_name_idx').on(t.toolName),
  uniqueIndex('tool_events_session_tooluse_uidx').on(t.sessionId, t.toolUseId)
])

export type ToolEvent = typeof toolEvents.$inferSelect
