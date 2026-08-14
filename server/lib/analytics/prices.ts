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
    if (typeof input !== 'number' || typeof output !== 'number') continue
    const creation = numStr(e.cache_creation_input_token_cost)
    out.push({
      model,
      inputCostPerToken: numStr(input),
      outputCostPerToken: numStr(output),
      cacheReadCostPerToken: numStr(e.cache_read_input_token_cost),
      cacheCreationCostPerToken: creation,
      // Absent 1h tier means the model has no separate long-cache rate — fall back to the 5m
      // rate rather than writing null, which would make the whole row unusable.
      cacheCreationAbove1hCostPerToken: numStr(e.cache_creation_input_token_cost_above_1hr, creation),
      source: 'litellm-price-map'
    })
  }
  return out
}
