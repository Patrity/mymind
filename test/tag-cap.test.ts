import { describe, it, expect } from 'vitest'
import { capTags } from '../shared/utils/cap-tags'

describe('capTags', () => {
  it('returns all tags when under the max', () => {
    const tags = ['alpha', 'beta', 'gamma']
    expect(capTags(tags)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('caps to max=10 by default when more than 10 tags given', () => {
    const tags = Array.from({ length: 15 }, (_, i) => `tag-${i}`)
    const result = capTags(tags)
    expect(result).toHaveLength(10)
    expect(result).toEqual(tags.slice(0, 10))
  })

  it('caps to a custom max', () => {
    const tags = ['a', 'b', 'c', 'd', 'e']
    expect(capTags(tags, 3)).toEqual(['a', 'b', 'c'])
  })

  it('deduplicates repeated tags', () => {
    const tags = ['alpha', 'beta', 'alpha', 'gamma', 'beta']
    expect(capTags(tags)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('normalises case to lowercase', () => {
    const tags = ['Alpha', 'BETA', 'Gamma']
    expect(capTags(tags)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('trims whitespace', () => {
    const tags = ['  alpha  ', ' beta', 'gamma ']
    expect(capTags(tags)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('deduplicates after normalisation (case+whitespace)', () => {
    const tags = ['Alpha', '  alpha  ', 'ALPHA']
    expect(capTags(tags)).toEqual(['alpha'])
  })

  it('filters out blank/whitespace-only entries', () => {
    const tags = ['alpha', '', '   ', 'beta']
    expect(capTags(tags)).toEqual(['alpha', 'beta'])
  })

  it('handles an empty array', () => {
    expect(capTags([])).toEqual([])
  })

  it('handles max=0 returning empty', () => {
    expect(capTags(['alpha', 'beta'], 0)).toEqual([])
  })

  it('preserves insertion order (first occurrence wins for dups)', () => {
    const tags = ['c', 'a', 'b', 'c', 'a']
    expect(capTags(tags)).toEqual(['c', 'a', 'b'])
  })

  it('dedup-then-cap: unique tags up to max', () => {
    // 5 unique, max 3 → first 3 unique
    const tags = ['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd', 'e', 'e']
    expect(capTags(tags, 3)).toEqual(['a', 'b', 'c'])
  })
})
