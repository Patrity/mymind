import { describe, it, expect } from 'vitest'
import { isHomeRange, homeRangeStart } from '../server/lib/home/range'

describe('isHomeRange', () => {
  it('accepts the four home keys', () => {
    for (const k of ['1d', '3d', '7d', '30d']) expect(isHomeRange(k)).toBe(true)
  })
  it('rejects keys from the other two range vocabularies', () => {
    // 1h/6h/24h are RangeKey (cycle 44); 90d/all are UsageRangeKey (cycle 55).
    for (const k of ['1h', '6h', '24h', '90d', 'all', '', 'garbage']) {
      expect(isHomeRange(k)).toBe(false)
    }
  })
})

describe('homeRangeStart', () => {
  const now = new Date('2026-08-15T09:30:00.000Z')

  it('truncates to UTC midnight and subtracts the range in days', () => {
    expect(homeRangeStart('1d', now).toISOString()).toBe('2026-08-14T00:00:00.000Z')
    expect(homeRangeStart('3d', now).toISOString()).toBe('2026-08-12T00:00:00.000Z')
    expect(homeRangeStart('7d', now).toISOString()).toBe('2026-08-08T00:00:00.000Z')
    expect(homeRangeStart('30d', now).toISOString()).toBe('2026-07-16T00:00:00.000Z')
  })

  it('is unaffected by the time of day', () => {
    const early = new Date('2026-08-15T00:00:01.000Z')
    const late = new Date('2026-08-15T23:59:59.000Z')
    expect(homeRangeStart('3d', early).toISOString()).toBe(homeRangeStart('3d', late).toISOString())
  })

  it('crosses a month boundary correctly', () => {
    expect(homeRangeStart('3d', new Date('2026-03-01T12:00:00.000Z')).toISOString())
      .toBe('2026-02-26T00:00:00.000Z')
  })
})
