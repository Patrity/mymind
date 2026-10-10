import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { conversations } from './conversations'
import { agentJobs } from './agent-config'

/** One row per agent turn, whatever started it. The DB claim (runtime/runs.ts) plus
 *  agent_runs_one_running make two concurrent turns on one conversation impossible. */
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  sessionKey: text('session_key').notNull(),
  trigger: text('trigger').notNull(),                 // 'user' | 'wake'
  wakeReason: text('wake_reason'),
  jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }), // set when trigger='wake' from a job fire
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Cycle 75: set when this run should answer back over a channel (e.g. an iMessage that
   *  woke the agent) rather than only the web UI. See runtime/types.ts ReplyTo. */
  replyTo: jsonb('reply_to')
}, (t) => [
  index('agent_runs_conv_status_idx').on(t.conversationId, t.status),
  index('agent_runs_status_created_idx').on(t.status, t.createdAt),
  uniqueIndex('agent_runs_one_running').on(t.conversationId).where(sql`status = 'running'`),
  // A job never overlaps itself: at most one queued-or-running run per job. The fire paths'
  // hasActiveRun checks are only fast paths; this index is what makes a race lose (jobs/tick.ts).
  uniqueIndex('agent_runs_one_active_per_job').on(t.jobId).where(sql`job_id is not null and status in ('queued', 'running')`),
  // "Any run of this job since X": the crash sweep's (not) exists checks (jobs/tick.ts) and
  // listRuns({ jobId }).
  index('agent_runs_job_created_idx').on(t.jobId, t.createdAt)
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
