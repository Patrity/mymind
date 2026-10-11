import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { conversations } from './conversations'

/** Cycle 81 (spec §5.1): a long-running, segmented, budgeted piece of agent work. Its log is its
 *  own thread (`conversation_id`, titled `⚙ <goal>`); each segment is one agent_runs row with
 *  kind='workstream' on that thread. lib/agent/workstreams/{store,loop}.ts own every transition. */
export const workstreams = pgTable('workstreams', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  // Where it was started from (summary + attention notes are posted there). Null once deleted.
  originConversationId: uuid('origin_conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  goal: text('goal').notNull(),
  state: text('state').notNull().default('queued').$type<'queued' | 'running' | 'attention' | 'paused' | 'done' | 'failed' | 'cancelled'>(),
  toolsets: text('toolsets').array().notNull().default(sql`'{}'::text[]`),
  budget: jsonb('budget').notNull(),                 // WorkstreamBudget
  used: jsonb('used').notNull(),                     // WorkstreamUsed — persisted every step
  attention: jsonb('attention'),                     // WorkstreamAttention | null
  summary: text('summary'),
  /** Why it failed (budget exhausted, repeated segment failure). Set while the final summary
   *  segment runs (state still 'running'), so a restart mid-summary still knows it is finishing. */
  failureReason: text('failure_reason'),
  /** Consecutive failed segments (a crash-interrupted one counts only when it recurs). 3 → failed. */
  failures: integer('failures').notNull().default(0),
  /** How the last segment ended: done | failed | interrupted | aborted. */
  lastOutcome: text('last_outcome'),
  /** Cancel asked for: the running segment stops after its current step. */
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  currentRunId: uuid('current_run_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true })
}, (t) => [
  uniqueIndex('workstreams_conversation_idx').on(t.conversationId),
  index('workstreams_state_idx').on(t.state, t.updatedAt)
])

export type WorkstreamRow = typeof workstreams.$inferSelect
