// The cost maths, in isolation. This is where a wrong number would come from: cache reads are
// ~95% of all tokens and price at ~10% of the input rate, so a flat input rate would overstate
// the total by roughly 10x.
import { describe, it, expect } from 'vitest'
import { parseUsage, computeValue } from '../server/lib/analytics/cost'
import type { ModelRates } from '../shared/types/usage'

// Real claude-opus-4-7 rates from LiteLLM's price map.
const OPUS: ModelRates = {
  input: 5e-6, output: 2.5e-5, cacheRead: 5e-7,
  cacheCreation: 6.25e-6, cacheCreationAbove1h: 1e-5
}

describe('parseUsage', () => {
  it('reads every field from a real Claude Code usage blob', () => {
    const t = parseUsage({
      input_tokens: 2, output_tokens: 2694,
      cache_read_input_tokens: 833477, cache_creation_input_tokens: 8271,
      cache_creation: { ephemeral_1h_input_tokens: 8271, ephemeral_5m_input_tokens: 0 }
    })
    expect(t).toEqual({
      input: 2, output: 2694, cacheRead: 833477,
      cacheCreation: 8271, ephemeral5m: 0, ephemeral1h: 8271
    })
  })

  it('returns zeros for null/garbage rather than throwing', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, ephemeral5m: 0, ephemeral1h: 0 }
    expect(parseUsage(null)).toEqual(zero)
    expect(parseUsage({})).toEqual(zero)
    expect(parseUsage({ input_tokens: 'nonsense' })).toEqual(zero)
  })

  it('tolerates a missing cache_creation object', () => {
    const t = parseUsage({ input_tokens: 10, cache_creation_input_tokens: 500 })
    expect(t.ephemeral5m).toBe(0)
    expect(t.ephemeral1h).toBe(0)
    expect(t.cacheCreation).toBe(500)
  })
})

describe('computeValue', () => {
  it('prices each of the five token classes at its own rate', () => {
    const v = computeValue(
      { input: 1000, output: 1000, cacheRead: 1000, cacheCreation: 2000, ephemeral5m: 1000, ephemeral1h: 1000 },
      OPUS
    )
    // 1000*5e-6 + 1000*2.5e-5 + 1000*5e-7 + 1000*6.25e-6 + 1000*1e-5 = 0.04675
    expect(v).toBeCloseTo(0.04675, 10)
  })

  it('does NOT price cache reads at the input rate — the 10x trap', () => {
    const readsOnly = { input: 0, output: 0, cacheRead: 1_000_000, cacheCreation: 0, ephemeral5m: 0, ephemeral1h: 0 }
    expect(computeValue(readsOnly, OPUS)).toBeCloseTo(0.5, 10)   // at cacheRead rate
    expect(computeValue(readsOnly, OPUS)).not.toBeCloseTo(5.0, 2) // NOT at input rate
  })

  it('prices the residual when cache_creation exceeds the ephemeral split', () => {
    // The real shape: 3 rows of 81,954 report cache_creation_input_tokens with BOTH tiers at 0.
    // Dropping the residual would silently under-report.
    const residualOnly = { input: 0, output: 0, cacheRead: 0, cacheCreation: 3028, ephemeral5m: 0, ephemeral1h: 0 }
    expect(computeValue(residualOnly, OPUS)).toBeCloseTo(3028 * 6.25e-6, 10)
  })

  it('prices the residual at the cheaper 5m rate, not the 1h rate', () => {
    const residualOnly = { input: 0, output: 0, cacheRead: 0, cacheCreation: 1000, ephemeral5m: 0, ephemeral1h: 0 }
    expect(computeValue(residualOnly, OPUS)).toBeCloseTo(1000 * 6.25e-6, 10)
    expect(computeValue(residualOnly, OPUS)).not.toBeCloseTo(1000 * 1e-5, 10)
  })

  it('never treats an over-counted split as negative value', () => {
    // Defensive: if the tiers ever exceed the reported total, the residual must clamp at 0.
    const over = { input: 0, output: 0, cacheRead: 0, cacheCreation: 100, ephemeral5m: 200, ephemeral1h: 0 }
    expect(computeValue(over, OPUS)).toBeCloseTo(200 * 6.25e-6, 10)
  })

  it('is zero for an all-zero row', () => {
    expect(computeValue({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, ephemeral5m: 0, ephemeral1h: 0 }, OPUS)).toBe(0)
  })
})
