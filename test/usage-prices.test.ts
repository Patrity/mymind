import { describe, it, expect } from 'vitest'
import { extractRates } from '../server/lib/analytics/prices'

// A fixture slice shaped exactly like LiteLLM's model_prices_and_context_window.json.
const MAP = {
  'claude-opus-4-7': {
    input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5
  },
  'model-without-1h': {
    input_cost_per_token: 1e-6, output_cost_per_token: 2e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6
  },
  'model-without-cache': { input_cost_per_token: 3e-6, output_cost_per_token: 6e-6 }
}

describe('extractRates', () => {
  it('maps the five rates for a fully-specified model', () => {
    const [r] = extractRates(MAP, ['claude-opus-4-7'])
    expect(r).toMatchObject({
      model: 'claude-opus-4-7',
      inputCostPerToken: '0.000005',
      outputCostPerToken: '0.000025',
      cacheReadCostPerToken: '0.0000005',
      cacheCreationCostPerToken: '0.00000625',
      cacheCreationAbove1hCostPerToken: '0.00001'
    })
  })

  it('falls back to the 5m rate when above_1hr is absent — never null', () => {
    const [r] = extractRates(MAP, ['model-without-1h'])
    expect(r!.cacheCreationAbove1hCostPerToken).toBe(r!.cacheCreationCostPerToken)
  })

  it('skips a model with no cache_read_input_token_cost — a silent $0 on ~95% of its volume is worse than a gap', () => {
    expect(extractRates(MAP, ['model-without-cache'])).toEqual([])
  })

  it('skips models absent from the map entirely — they become the unpriced bucket', () => {
    expect(extractRates(MAP, ['<synthetic>'])).toEqual([])
    expect(extractRates(MAP, ['claude-opus-4-7', '<synthetic>'])).toHaveLength(1)
  })

  it('skips a model with no input/output cost — a price entry that prices nothing is not a price', () => {
    expect(extractRates({ 'weird': { max_tokens: 100 } }, ['weird'])).toEqual([])
  })
})
