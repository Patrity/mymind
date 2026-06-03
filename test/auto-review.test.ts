import { describe, it, expect } from 'vitest'
import { shouldAutoReview, stripUnreviewed } from '../server/services/memory'

describe('shouldAutoReview', () => {
  it('returns true when confidence >= threshold', () => {
    expect(shouldAutoReview(0.9, 0.75)).toBe(true)
    expect(shouldAutoReview(0.75, 0.75)).toBe(true)
  })

  it('returns false when confidence < threshold', () => {
    expect(shouldAutoReview(0.5, 0.75)).toBe(false)
    expect(shouldAutoReview(0.74, 0.75)).toBe(false)
  })

  it('returns false when confidence is null', () => {
    expect(shouldAutoReview(null, 0.75)).toBe(false)
  })

  it('returns false when confidence is undefined', () => {
    expect(shouldAutoReview(undefined, 0.75)).toBe(false)
  })
})

describe('stripUnreviewed', () => {
  it('removes the unreviewed tag', () => {
    expect(stripUnreviewed(['unreviewed', 'foo'])).toEqual(['foo'])
    expect(stripUnreviewed(['foo', 'unreviewed', 'bar'])).toEqual(['foo', 'bar'])
  })

  it('preserves non-unreviewed tags in order', () => {
    expect(stripUnreviewed(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('deduplicates remaining tags', () => {
    expect(stripUnreviewed(['unreviewed', 'foo', 'foo', 'bar'])).toEqual(['foo', 'bar'])
  })

  it('returns empty array when only unreviewed tag exists', () => {
    expect(stripUnreviewed(['unreviewed'])).toEqual([])
  })

  it('returns empty array when input is empty', () => {
    expect(stripUnreviewed([])).toEqual([])
  })
})
