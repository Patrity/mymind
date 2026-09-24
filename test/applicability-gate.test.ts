import { describe, it, expect } from 'vitest'
import { decideApplicability, shouldEnqueueReview } from '../scripts/lib/applicability'

describe('decideApplicability', () => {
  it('writes global only above the high gate', () => {
    expect(decideApplicability(0.95)).toBe('global')
  })

  it('writes project only below the low gate', () => {
    expect(decideApplicability(0.05)).toBe('project')
  })

  it('sends the uncertain middle to review rather than guessing', () => {
    expect(decideApplicability(0.5)).toBe('review')
    expect(decideApplicability(0.7)).toBe('review')
  })

  it('treats the gates as inclusive bounds', () => {
    expect(decideApplicability(0.9, { high: 0.9, low: 0.1 })).toBe('global')
    expect(decideApplicability(0.1, { high: 0.9, low: 0.1 })).toBe('project')
  })

  it('defaults an out-of-range or NaN score to review, never to global', () => {
    expect(decideApplicability(Number.NaN)).toBe('review')
    expect(decideApplicability(1.5)).toBe('review')
    expect(decideApplicability(-1)).toBe('review')
  })
})

describe('shouldEnqueueReview', () => {
  it('never files a review-queue row for a review verdict (RULING 18)', () => {
    expect(shouldEnqueueReview('review')).toBe(false)
  })
})
