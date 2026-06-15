import { describe, it, expect } from 'vitest'
import { pruneCutoffs } from '../server/services/activity'
import { DEFAULT_CONFIG } from '../server/lib/observability/types'

describe('pruneCutoffs', () => {
  it('computes info + error cutoffs from now and retention days', () => {
    const now = new Date('2026-06-15T00:00:00Z').getTime()
    const { infoCutoff, errorCutoff } = pruneCutoffs(DEFAULT_CONFIG, now)
    // info: 14 days back, error: 90 days back
    expect(infoCutoff.toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(errorCutoff.toISOString()).toBe('2026-03-17T00:00:00.000Z')
  })
})
