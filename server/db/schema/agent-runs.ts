import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { conversations } from './conversations'

/** One row per agent turn, whatever started it. The DB claim (runtime/runs.ts) plus
 *  agent_runs_one_running make two concurrent turns on one conversation impossible. */
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  sessionKey: text('session_key').notNull(),
  trigger: text('trigger').notNull(),                 // 'user' | 'wake'
  wakeReason: text('wake_reason'),
  profile: text('profile').notNull(),                 // 'interactive' | 'headless'
  modelDefId: text('model_def_id'),
  status: text('status').notNull().default('queued'), // queued|running|done|failed|interrupted|aborted
  suppressed: boolean('suppressed').notNull().default(false),
  input: jsonb('input').notNull(),                    // RunInput
  originSinkId: text('origin_sink_id'),               // the socket that sent it (audio + approvals)
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  aliveAt: timestamp('alive_at', { withTimezone: true }),
  owner: text('owner'),                               // boot id of the process that claimed it
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
  usage: jsonb('usage'),
  userMessageId: uuid('user_message_id'),
  assistantMessageId: uuid('assistant_message_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('agent_runs_conv_status_idx').on(t.conversationId, t.status),
  index('agent_runs_status_created_idx').on(t.status, t.createdAt),
  uniqueIndex('agent_runs_one_running').on(t.conversationId).where(sql`status = 'running'`)
])

/** Messages that arrive while a run is busy. 'steer' rows are drained into the running turn
 *  at its next step boundary; consumed_by_run marks them used. */
export const agentInbox = pgTable('agent_inbox', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull(),                       // 'steer' | 'followup' (followup unused this cycle)
  content: text('content').notNull(),
  attachments: jsonb('attachments'),
  source: text('source').notNull(),                   // 'user' | 'wake'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp('consumed_at', { withTimezone: true })
}, (t) => [
  index('agent_inbox_run_idx').on(t.runId, t.consumedAt)
])

export type AgentRun = typeof agentRuns.$inferSelect
export type AgentInboxRow = typeof agentInbox.$inferSelect
