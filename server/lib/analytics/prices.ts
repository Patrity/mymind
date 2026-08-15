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
