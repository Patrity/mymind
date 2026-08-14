import { describe, it, expect } from 'vitest'
import { rangeStart, isUsageRange } from '../server/services/usage'

describe('usage range parsing', () => {
  it('accepts only the four known ranges', () => {
    expect(isUsageRange('7d')).toBe(true)
    expect(isUsageRange('30d')).toBe(true)
    expect(isUsageRange('90d')).toBe(true)
    expect(isUsageRange('all')).toBe(true)
  })

  it('rejects anything else, including the Prometheus range keys', () => {
    // '1h'/'6h'/'24h' are valid RangeKeys for the Infrastructure tab and MUST NOT be
    // accepted here — the two value spaces are disjoint.
    for (const bad of ['1h', '6h', '24h', '', 'all; drop table', '8d', 'ALL']) {
      expect(isUsageRange(bad)).toBe(false)
    }
  })

  it('maps ranges to a UTC day boundary in the past', () => {
    const now = new Date('2026-08-14T12:34:56Z')
    expect(rangeStart('7d', now)!.toISOString()).toBe('2026-08-07T00:00:00.000Z')
    expect(rangeStart('30d', now)!.toISOString()).toBe('2026-07-15T00:00:00.000Z')
  })

  it('returns null for "all" — meaning no lower bound', () => {
    expect(rangeStart('all', new Date())).toBeNull()
  })
})
