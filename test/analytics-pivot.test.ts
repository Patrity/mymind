import { describe, it, expect } from 'vitest'
import { pivotSeries } from '../app/utils/analytics-pivot'

describe('pivotSeries', () => {
  it('merges series on timestamp into row objects', () => {
    const { rows, keys } = pivotSeries([
      { name: 'A', points: [{ t: 1000, v: 1 }, { t: 2000, v: 2 }] },
      { name: 'B', points: [{ t: 1000, v: 9 }] }
    ])
    expect(keys).toEqual(['A', 'B'])
    expect(rows).toEqual([
      { t: 1000, A: 1, B: 9 },
      { t: 2000, A: 2, B: null }
    ])
  })
  it('keeps null gaps and sorts by time', () => {
    const { rows } = pivotSeries([{ name: 'A', points: [{ t: 2000, v: null }, { t: 1000, v: 5 }] }])
    expect(rows).toEqual([{ t: 1000, A: 5 }, { t: 2000, A: null }])
  })
  it('empty input -> empty rows/keys', () => {
    expect(pivotSeries([])).toEqual({ rows: [], keys: [] })
  })
})
