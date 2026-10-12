import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, real, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'

// Cycle 84 (spec §2.5): one row per approval request the judge saw — the rule floor (instant), the
// LLM verdict (when it lands) and the final decision (Tony, the judge's auto-approval, or a
// timeout). Keyed by the approval nonce buildAiTools mints per execution. The rule tier writes the
// row first; a verdict arriving after the decision is still recorded and changes nothing.
// `reasons`/`rule_reasons` are short text; `reasons` is model output (render escaped, never as
// markup). The approval `command` body is deliberately NOT stored here (cycle 79 logging rule).
// No foreign keys: the audit outlives the runs and workstreams it describes.
export const approvalVerdicts = pgTable('approval_verdicts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  nonce: text('nonce').notNull(),
  runId: uuid('run_id'),
  workstreamId: uuid('workstream_id'),
  tool: text('tool').notNull(),
  ruleFloor: text('rule_floor').notNull(),            // 'low' | 'review' | 'high' | 'critical' | 'deny'
  ruleReasons: jsonb('rule_reasons').$type<string[]>().notNull().default([]),
  risk: text('risk'),                                 // null until the verdict lands, or on a judge error
  recommendation: text('recommendation'),             // 'approve' | 'review' | 'deny'
  confidence: real('confidence'),
  reasons: jsonb('reasons').$type<string[]>(),
  model: text('model'),
  latencyMs: integer('latency_ms'),
  error: text('error'),
  verdictAt: timestamp('verdict_at', { withTimezone: true }),
  decision: text('decision'),                         // 'approved' | 'denied' | 'auto' | 'timeout' | 'cancelled'
  decidedBy: text('decided_by'),                      // 'tony' | 'judge' | 'timeout' | 'system' (Stop, /clear, drain, cancel, no channel)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true })
}, (t) => [
  uniqueIndex('approval_verdicts_nonce_idx').on(t.nonce),
  index('approval_verdicts_run_idx').on(t.runId),
  index('approval_verdicts_created_idx').on(t.createdAt)
])

export type ApprovalVerdictRow = typeof approvalVerdicts.$inferSelect
