import { describe, it, expect } from 'vitest'
import { rrfFuse } from '../server/lib/ai/rrf'

describe('rrfFuse', () => {
  it('fuses ranked id lists by reciprocal rank', () => {
    // a is rank0 in lane1 and rank1 in lane2 -> highest combined
    const out = rrfFuse([['a', 'b', 'c'], ['x', 'a', 'b']], 60)
    expect(out[0]).toBe('a')
    expect(new Set(out)).toEqual(new Set(['a', 'b', 'c', 'x']))
  })
  it('handles empty lanes and single lane', () => {
    expect(rrfFuse([], 60)).toEqual([])
    expect(rrfFuse([['a', 'b']], 60)).toEqual(['a', 'b'])
  })
  it('dedups ids that appear in multiple lanes', () => {
    const out = rrfFuse([['a', 'a', 'b'], ['a']], 60)
    expect(out.filter(x => x === 'a')).toHaveLength(1)
  })
})
