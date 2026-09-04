import type { NewModelPrice } from '../../db/schema/model-prices'

export const PRICE_MAP_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

const numStr = (v: unknown, fallback = '0'): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') : fallback

/**
 * Pull the five rates we price with out of LiteLLM's price map, for the models we actually see.
 *
 * Split from the fetch so it is testable without network. Models absent from the map are skipped
 * entirely — they surface as the "unpriced" bucket rather than as zero-value rows. `<synthetic>`
 * (Claude Code's marker for locally-generated messages) is the permanent example.
 */
export function extractRates(map: Record<string, unknown>, models: string[]): NewModelPrice[] {
  const out: NewModelPrice[] = []
  for (const model of models) {
    const e = map[model] as Record<string, unknown> | undefined
    if (!e) continue
    const input = e.input_cost_per_token
    const output = e.output_cost_per_token
    const cacheRead = e.cache_read_input_token_cost
    // Cache reads are ~95% of token volume on the real corpus — a model missing this rate is
    // NOT "no cache tier", it's a price-map gap. Defaulting it to 0 would silently zero-price
    // the bulk of that model's usage while still landing it in `model_prices`, which would
    // wrongly EXCLUDE it from the unpriced bucket (a zero that looks like priced data is worse
    // than a gap that admits it — the whole point of the unpriced bucket). Skip the model
    // instead, exactly like a missing input/output cost.
    if (typeof input !== 'number' || typeof output !== 'number' || typeof cacheRead !== 'number') continue
    const creation = numStr(e.cache_creation_input_token_cost)
    out.push({
      model,
      inputCostPerToken: numStr(input),
      outputCostPerToken: numStr(output),
      cacheReadCostPerToken: numStr(cacheRead),
      cacheCreationCostPerToken: creation,
      // Absent 1h tier means the model has no separate long-cache rate — fall back to the 5m
      // rate rather than writing null, which would make the whole row unusable.
      cacheCreationAbove1hCostPerToken: numStr(e.cache_creation_input_token_cost_above_1hr, creation),
      source: 'litellm-price-map'
    })
  }
  return out
}

/** How long a full price refresh stays fresh. Rates change rarely; this is the floor, not the goal. */
export const PRICE_MAX_AGE_MS = 20 * 60 * 60 * 1000

export type SyncDecision = {
  sync: boolean
  reason: 'new-model' | 'stale' | 'none'
  newModels: string[]
}

/**
 * Decide whether a price sync should actually hit the network.
 *
 * The scheduled task runs often so a newly-adopted model gets priced within minutes instead of
 * waiting up to a day (claude-fable-5-1 sat unpriced for ~11h on 2026-09-03 for exactly this
 * reason). But the full sync scans every row of `messages` and pulls a ~2MB map, so it must NOT
 * run on every tick.
 *
 * Two triggers, both cheap to evaluate:
 *  - `new-model`: a model showed up in the recent window that we have never *attempted* to price.
 *    Attempted — not priced — is the important word. `<synthetic>` and anything else missing from
 *    the upstream map is unpriceable forever, and keying off "has no price row" would re-fetch on
 *    every single tick for those. Recording what we tried is what makes frequent scheduling safe.
 *  - `stale`: the last full sync is older than PRICE_MAX_AGE_MS, so rates get refreshed even when
 *    the model set is unchanged. A null `lastFullSyncAt` (cold start) counts as stale.
 */
export function decideSync(opts: {
  recentModels: string[]
  attempted: string[]
  lastFullSyncAt: Date | null
  now: Date
  maxAgeMs?: number
}): SyncDecision {
  const attempted = new Set(opts.attempted)
  const newModels = [...new Set(opts.recentModels.filter(m => m && !attempted.has(m)))]
  if (newModels.length > 0) return { sync: true, reason: 'new-model', newModels }

  const maxAge = opts.maxAgeMs ?? PRICE_MAX_AGE_MS
  const stale = !opts.lastFullSyncAt || opts.now.getTime() - opts.lastFullSyncAt.getTime() >= maxAge
  return stale ? { sync: true, reason: 'stale', newModels: [] } : { sync: false, reason: 'none', newModels: [] }
}
