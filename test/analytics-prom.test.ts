import { describe, it, expect } from 'vitest'
import { stepForRange, windowForRange, rangeSeconds, toSeries } from '../server/lib/analytics/prom'

describe('prom range math', () => {
  it('steps target 120-300 points per range', () => {
    expect(stepForRange('1h')).toBe(30)
    expect(stepForRange('6h')).toBe(120)
    expect(stepForRange('24h')).toBe(300)
    expect(stepForRange('7d')).toBe(3600)
  })
  it('windows are >= 2x step (rate() needs >= 2 samples)', () => {
    expect(windowForRange('1h')).toBe('2m')
    expect(windowForRange('6h')).toBe('10m')
    expect(windowForRange('24h')).toBe('30m')
    expect(windowForRange('7d')).toBe('3h')
  })
  it('rangeSeconds maps keys', () => {
    expect(rangeSeconds('1h')).toBe(3600)
    expect(rangeSeconds('7d')).toBe(7 * 86400)
  })
})

describe('toSeries', () => {
  const matrix = [
    { metric: { uuid: 'abc', job: 'nvidia-gpu' }, values: [[1751800000, '42.5'], [1751800030, 'NaN']] as [number, string][] },
    { metric: { uuid: 'def', job: 'nvidia-gpu' }, values: [[1751800000, '7']] as [number, string][] },
  ]
  it('maps each result to a named series with epoch-ms points, NaN -> null', () => {
    const s = toSeries(matrix, m => m.uuid ?? '?')
    expect(s).toEqual([
      { name: 'abc', points: [{ t: 1751800000000, v: 42.5 }, { t: 1751800030000, v: null }] },
      { name: 'def', points: [{ t: 1751800000000, v: 7 }] },
    ])
  })
  it('handles empty input', () => {
    expect(toSeries([], () => 'x')).toEqual([])
  })
})
