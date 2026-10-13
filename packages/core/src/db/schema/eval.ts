import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, real, boolean, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'

// Cycle 85 (spec §3.1): the eval substrate's own records — suites of cases, runs and per-attempt
// results. These are the ONLY public tables an eval world does not shadow (lib/eval/tenant.ts:
// `eval_*`): the runner writes runs/results here; everything the agent writes during an attempt
// lives in the world's tenant schema and is dropped with it.

export const evalSuites = pgTable('eval_suites', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, t => [uniqueIndex('eval_suites_name_idx').on(t.name)])

/** An expected / forbidden action: a tool call, optionally with args (exact subset) or an
 *  args_pattern (regexes per arg). Scored by Task 3's matcher. */
export interface EvalActionSpec {
  tool: string
  args?: Record<string, unknown>
  args_pattern?: Record<string, string>
}

export const evalCases = pgTable('eval_cases', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  suiteId: uuid('suite_id').notNull().references(() => evalSuites.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  prompt: text('prompt').notNull(),
  surface: text('surface').notNull().default('chat'),                 // 'chat' | 'workstream'
  setup: jsonb('setup').$type<Record<string, unknown>>().notNull().default({}),
  expectedActions: jsonb('expected_actions').$type<EvalActionSpec[]>().notNull().default([]),
  forbiddenActions: jsonb('forbidden_actions').$type<EvalActionSpec[]>().notNull().default([]),
  expectedContent: text('expected_content').array().notNull().default(sql`'{}'::text[]`),
  matchMode: text('match_mode').notNull().default('ordered_subset'),  // 'ordered_subset' | 'exact' | 'subset' | 'contains_any'
  rubric: text('rubric'),
  nRuns: integer('n_runs').notNull().default(3),
  maxSteps: integer('max_steps').notNull().default(40),
  holdout: boolean('holdout').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, t => [uniqueIndex('eval_cases_suite_slug_idx').on(t.suiteId, t.slug)])

export const evalRuns = pgTable('eval_runs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  suiteId: uuid('suite_id').notNull().references(() => evalSuites.id, { onDelete: 'cascade' }),
  gitSha: text('git_sha'),
  modelLabel: text('model_label'),
  promptHash: text('prompt_hash'),
  toolsHash: text('tools_hash'),
  status: text('status').notNull().default('queued'),                 // 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  summary: jsonb('summary').$type<Record<string, unknown>>(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true })
}, t => [index('eval_runs_suite_idx').on(t.suiteId, t.startedAt)])

export const evalResults = pgTable('eval_results', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  runId: uuid('run_id').notNull().references(() => evalRuns.id, { onDelete: 'cascade' }),
  caseId: uuid('case_id').notNull().references(() => evalCases.id, { onDelete: 'cascade' }),
  attempt: integer('attempt').notNull(),
  score: real('score'),
  passed: boolean('passed'),
  toolLog: jsonb('tool_log').$type<unknown[]>().notNull().default([]),
  finalText: text('final_text'),
  outcome: jsonb('outcome').$type<Record<string, unknown>>(),
  capturedWrites: jsonb('captured_writes').$type<unknown[]>().notNull().default([]),
  error: text('error'),
  durationMs: integer('duration_ms'),
  tokens: integer('tokens'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => [
  index('eval_results_run_idx').on(t.runId, t.caseId, t.attempt),
  index('eval_results_case_idx').on(t.caseId)
])

export type EvalSuiteRow = typeof evalSuites.$inferSelect
export type EvalCaseRow = typeof evalCases.$inferSelect
export type EvalRunRow = typeof evalRuns.$inferSelect
export type EvalResultRow = typeof evalResults.$inferSelect
