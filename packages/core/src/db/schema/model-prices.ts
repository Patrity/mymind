import { pgTable, text, numeric, timestamp } from 'drizzle-orm/pg-core'

/**
 * Per-model token rates, mirrored from LiteLLM's public price map.
 *
 * Stored rather than fetched per render for three reasons: the upstream map is ~1.7 MB (far too
 * heavy for a page load), storing it keeps the value tile working when the network is unreachable,
 * and it leaves an auditable record of which rate produced a given number.
 *
 * `numeric` (not `real`) because these are ~1e-7 magnitudes multiplied by billions of tokens —
 * float drift is visible at that scale.
 */
export const modelPrices = pgTable('model_prices', {
  model: text('model').primaryKey(),
  inputCostPerToken: numeric('input_cost_per_token').notNull(),
  outputCostPerToken: numeric('output_cost_per_token').notNull(),
  cacheReadCostPerToken: numeric('cache_read_cost_per_token').notNull(),
  cacheCreationCostPerToken: numeric('cache_creation_cost_per_token').notNull(),
  cacheCreationAbove1hCostPerToken: numeric('cache_creation_above_1h_cost_per_token').notNull(),
  source: text('source').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow()
})

export type ModelPrice = typeof modelPrices.$inferSelect
export type NewModelPrice = typeof modelPrices.$inferInsert
