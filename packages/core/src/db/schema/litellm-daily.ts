import { pgTable, text, date, bigint, numeric, primaryKey } from 'drizzle-orm/pg-core'

/**
 * Daily rollup of LiteLLM traffic, sourced from the Prometheus metrics the live panels already
 * query (`litellm_total_spend` / `litellm_total_tokens` / `litellm_requests_total`).
 *
 * A deliberate, scoped exception to the cycle-44 rule that "MyMind collects and stores no metrics".
 * That rule stands for live telemetry; it is also exactly what caps usable history at Prometheus
 * retention. Persisting a daily rollup buys unbounded history AND lets the combined chart be one
 * Postgres query instead of a Postgres-join-Prometheus per render. Do not "fix" this back.
 *
 * `spend` here is REAL MONEY, unlike the API-equivalent value computed for Claude Code usage.
 */
export const litellmDaily = pgTable('litellm_daily', {
  day: date('day').notNull(),
  model: text('model').notNull(),
  tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
  spend: numeric('spend').notNull().default('0'),
  requests: bigint('requests', { mode: 'number' }).notNull().default(0)
}, (t) => [
  primaryKey({ columns: [t.day, t.model] })
])

export type LitellmDaily = typeof litellmDaily.$inferSelect
export type NewLitellmDaily = typeof litellmDaily.$inferInsert
