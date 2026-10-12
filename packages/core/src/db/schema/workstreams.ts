import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core'
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
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  // Cycle 83 (coordinator, spec §2). Non-null = a CHILD of that coordinator (depth 1: a child's
  // parent never has a parent — enforced by the spawn path under the tree lock).
  parentId: uuid('parent_id').references((): AnyPgColumn => workstreams.id, { onDelete: 'set null' }),
  /** The `subagents` label a child runs on (null = the default resolution). */
  modelLabel: text('model_label'),
  /** A child's workspace: its own sandbox, or its coordinator's. */
  workspaceMode: text('workspace_mode').notNull().default('own').$type<'own' | 'shared'>(),
  /** A coordinator's tree budget ({ maxSteps }) — its CHILDREN's reservations, in steps (final fix
   *  wave I1; rows written before it may also carry a maxWallMs, which is ignored). */
  treeBudget: jsonb('tree_budget'),
  /** Rolled up: own `used` + every child's `used` (refreshed at every step of any tree member). */
  treeUsed: jsonb('tree_used'),
  /** A run of this workstream read mail/calendar/contacts content (cycle 83: a tainted child taints
   *  the coordinator run that reads its output). Never cleared. */
  tainted: boolean('tainted').notNull().default(false),
  /** Cycle 83 fix round 1 (I2): a CHILD, set at spawn and never cleared. Every child rule (depth 1,
   *  no coordinator toolset, notes to the coordinator, tree accounting) keys on THIS, not on
   *  `parent_id` — which goes NULL when the coordinator's row is deleted. A child whose coordinator
   *  vanished is cancelled (coordinator.ts sweep), never promoted to top-level work. */
  isChild: boolean('is_child').notNull().default(false),
  /** Cycle 83 fix round 1 (S1): the last lifecycle event of this child written into its coordinator's
   *  thread as a state-only note (`spawned`, `attention:<kind>:<hash>`, `paused:<hash>`, `done`…). */
  lifecycleNoted: text('lifecycle_noted'),
  /** Cycle 83 final fix wave (M4): on a COORDINATOR — when Tony was last texted about its children
   *  (approvals, escalated questions): at most one such text per tree per 10 minutes. */
  treeAwayAt: timestamp('tree_away_at', { withTimezone: true })
}, (t) => [
  index('workstreams_parent_idx').on(t.parentId),
  uniqueIndex('workstreams_conversation_idx').on(t.conversationId),
  index('workstreams_state_idx').on(t.state, t.updatedAt)
])

export type WorkstreamRow = typeof workstreams.$inferSelect
