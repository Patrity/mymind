import { describe, it, expect } from 'vitest'
import { anchorAfterPrepend } from './anchor'

describe('anchorAfterPrepend', () => {
  it('keeps the viewport on the same content by adding the height that appeared above it', () => {
    // Was at 1,000px; 3,000px of older rows were prepended above.
    expect(anchorAfterPrepend({ scrollTop: 1000, prevScrollHeight: 5000, nextScrollHeight: 8000 })).toBe(4000)
  })

  it('is a no-op when nothing was added', () => {
    expect(anchorAfterPrepend({ scrollTop: 1000, prevScrollHeight: 5000, nextScrollHeight: 5000 })).toBe(1000)
  })

  it('never returns a negative offset if the list somehow shrank', () => {
    expect(anchorAfterPrepend({ scrollTop: 100, prevScrollHeight: 5000, nextScrollHeight: 4000 })).toBe(0)
  })
})
