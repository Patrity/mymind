// server/db/schema/agent-improve.ts
// Cycle 76: Bridget self-improvement — the reflector's inputs (profile, signals) and outputs
// (improvements). Revisions for `target_kind = 'profile'` reuse `agent_config_revisions`
// (server/db/schema/agent-config.ts) rather than a table here.
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { agentJobs } from './agent-config'
import { agentRuns } from './agent-runs'

/** Bridget's self-written persona addendum. One row, like a skill. Reflection never edits this
 *  directly (spec §5 tier + §6 apply) — only a reviewed/auto-applied `profile.edit` improvement
 *  does, via the same store path as a human edit. */
export const agentProfile = pgTable('agent_profile', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  content: text('content').notNull().default(''),
  contentHash: text('content_hash').notNull(),
  updatedBy: text('updated_by').notNull().default('human'), // 'human' | 'agent:reflection'
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

/** One row per engagement observation on a proactive message — evidence the nightly reflector
 *  pass reasons over. jobId/runId are best-effort provenance: set null so a pruned job/run
 *  doesn't take its signals with it. */
export const agentSignals = pgTable('agent_signals', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  messageId: uuid('message_id'),   // the assistant row the signal is about
  deliveryId: uuid('delivery_id'),
  kind: text('kind').notNull(),    // 'replied' | 'tapback_positive' | 'tapback_negative' | 'said_stop' | 'said_thanks' | 'ignored'
  detail: text('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('agent_signals_job_created_idx').on(t.jobId, t.createdAt),
  // At most one signal of a given kind per message (e.g. one 'replied' per assistant message).
  uniqueIndex('agent_signals_message_kind').on(t.messageId, t.kind).where(sql`${t.messageId} is not null`)
])

/** Every proposal the reflector makes, whatever happened to it — from raised through the gate
 *  (route, dropReason) to decided (revisionId / reviewItemId once applied or queued). */
export const agentImprovements = pgTable('agent_improvements', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  pass: text('pass').notNull(),                     // 'thread' | 'jobs'
  sourceConversationId: uuid('source_conversation_id'),
  sourceRunIds: uuid('source_run_ids').array().notNull().default(sql`'{}'::uuid[]`),
  kind: text('kind').notNull(),                     // 'skill.create' | 'skill.edit' | 'profile.edit' | 'job.edit' | 'job.disable'
  target: text('target').notNull(),                 // skill slug / job slug / 'profile'
  proposal: jsonb('proposal').notNull(),             // { target, content | edit, reason, confidence, evidence: string[] }
  jev: jsonb('jev'),                                 // raw Jev answers, nullable
  route: text('route').notNull(),                    // 'auto' | 'review' | 'dropped'
  dropReason: text('drop_reason'),
  status: text('status').notNull(),                  // 'applied' | 'pending_review' | 'rejected' | 'dropped' | 'conflict' | 'deciding' (claimed, transient)
  revisionId: uuid('revision_id'),
  reviewItemId: uuid('review_item_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true })
}, (t) => [
  index('agent_improvements_status_created_idx').on(t.status, t.createdAt),
  index('agent_improvements_kind_target_created_idx').on(t.kind, t.target, t.createdAt)
])

export type AgentProfileRow = typeof agentProfile.$inferSelect
export type AgentSignalRow = typeof agentSignals.$inferSelect
export type AgentImprovementRow = typeof agentImprovements.$inferSelect
