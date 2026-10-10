import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core'

// Unified observability ledger: one row per captured span (inbound request,
// cron job, model call, failover attempt, agent tool call). Correlated by
// trace_id (the root operation) + parent_id (self-ref nesting). See
// docs/superpowers/specs/2026-06-15-activity-log-observability-design.md
export const activityLog = pgTable('activity_log', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  traceId: uuid('trace_id').notNull(),
  parentId: uuid('parent_id'),
  kind: text('kind').notNull(),          // inbound | job | model | attempt | tool
  name: text('name').notNull(),
  status: text('status').notNull(),      // ok | error | warn
  severity: text('severity').notNull(),  // debug | info | warn | error
  usage: text('usage'),
  provider: text('provider'),
  modelId: text('model_id'),
  attempt: integer('attempt'),
  durationMs: integer('duration_ms'),
  tokens: jsonb('tokens'),
  request: jsonb('request'),
  response: jsonb('response'),
  error: jsonb('error'),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
  ackedAt: timestamp('acked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true })
}, (t) => [
  index('activity_created_idx').on(t.createdAt.desc()),
  index('activity_trace_idx').on(t.traceId),
  index('activity_kind_idx').on(t.kind),
  index('activity_severity_idx').on(t.severity)
])

export type ActivityRow = typeof activityLog.$inferSelect
export type ActivityInsert = typeof activityLog.$inferInsert
