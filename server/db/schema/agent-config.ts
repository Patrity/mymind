import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, boolean, integer, timestamp, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core'
import { agentRuns } from './agent-runs'

/** Agent skills — markdown with frontmatter is the single source of truth (cycle 74). */
export const agentSkills = pgTable('agent_skills', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  // Derived from `content` on every write — never edited directly.
  name: text('name'),
  description: text('description'),
  whenToUse: text('when_to_use'),
  active: boolean('active').notNull().default(true),
  source: text('source').notNull().default('human'), // 'human' | 'agent'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [uniqueIndex('agent_skills_slug').on(t.slug)])

/** Agent jobs — markdown with frontmatter (trigger, timezone, …) + prompt body. */
export const agentJobs = pgTable('agent_jobs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  source: text('source').notNull().default('human'),
  // Derived on every write.
  enabled: boolean('enabled').notNull().default(false),
  triggerKind: text('trigger_kind'),      // 'cron' | 'every' | 'at' | 'event'
  triggerExpr: text('trigger_expr'),
  timezone: text('timezone'),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  parseError: text('parse_error'),
  // Runtime.
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastRunId: uuid('last_run_id'),
  lastOutcome: text('last_outcome'),      // 'spoke' | 'silent' | 'failed' | 'skipped'
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  // Failed wakes of an `at` job in a row (a wake that threw, or a crash the sweep repaired) —
  // not run outcomes. Reset when a run is created; at MAX_FIRE_FAILURES the job gives up (tick.ts).
  fireFailures: integer('fire_failures').notNull().default(0),
  firedAt: timestamp('fired_at', { withTimezone: true }), // set when an `at` job has fired (pruning)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  uniqueIndex('agent_jobs_slug').on(t.slug),
  index('agent_jobs_due').on(t.nextRunAt).where(sql`enabled and parse_error is null`)
])

export const agentConfigRevisions = pgTable('agent_config_revisions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  targetKind: text('target_kind').notNull(), // 'skill' | 'job'
  targetId: uuid('target_id').notNull(),
  content: text('content').notNull(),
  actor: text('actor').notNull(),            // 'human' | 'agent' | 'system'
  runId: uuid('run_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [index('agent_config_revisions_target').on(t.targetKind, t.targetId, t.createdAt)])

export const agentJobFires = pgTable('agent_job_fires', {
  jobId: uuid('job_id').notNull().references(() => agentJobs.id, { onDelete: 'cascade' }),
  eventKey: text('event_key').notNull(),
  firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
  // The run this fire started. NULL = the wake has not landed yet; a row still NULL after
  // 2 minutes is a crashed fire, and the crash sweep (jobs/tick.ts) deletes it so the key can fire again.
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' })
}, (t) => [primaryKey({ columns: [t.jobId, t.eventKey], name: 'agent_job_fires_pkey' })])

export type AgentSkillRow = typeof agentSkills.$inferSelect
export type AgentJobRow = typeof agentJobs.$inferSelect
