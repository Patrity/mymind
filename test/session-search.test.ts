import { describe, it, expect } from 'vitest'
import { rrfFuse } from '../server/lib/ai/rrf'

describe('rrfFuse (used by session/message search)', () => {
  it('ranks an item appearing high in both lanes above single-lane items', () => {
    // Simulates: 'a' is top trigram hit AND top vector hit → should win fusion
    const fused = rrfFuse([['a', 'b', 'c'], ['a', 'x', 'y']])
    expect(fused[0]).toBe('a') // top of both lanes → highest fused score
    expect(fused).toContain('b')
    expect(fused).toContain('x')
  })

  it('returns empty for empty lanes', () => {
    expect(rrfFuse([[], []])).toEqual([])
  })

  it('preserves all ids from both lanes with no duplicates', () => {
    const fused = rrfFuse([['a', 'b'], ['b', 'c']])
    expect(fused).toHaveLength(3)
    expect(new Set(fused).size).toBe(3)
    // 'b' appears in both lanes → should outrank 'a' (rank-0 in one lane only)
    // and 'c' (rank-1 in one lane only)
    expect(fused[0]).toBe('b')
  })

  it('falls back gracefully with a single populated lane (trigram-only mode)', () => {
    // Mirrors the vector-lane fallback: vecIds = [] when embedOne throws
    const fused = rrfFuse([['x', 'y', 'z'], []])
    expect(fused).toEqual(['x', 'y', 'z'])
  })
})
