import { describe, it, expect } from 'vitest'
import { computeLayout, computeLayoutAsync } from '../server/lib/galaxy/layout'

describe('computeLayoutAsync', () => {
  it('matches computeLayout exactly for the same seed', async () => {
    let s = 7; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32)
    const items = Array.from({ length: 60 }, (_, i) => ({ type: 'memory', id: `m${i}`, vector: Array.from({ length: 16 }, rnd) }))
    expect(await computeLayoutAsync(items, 42, { yieldEvery: 5 })).toEqual(computeLayout(items, 42))
  })
})
