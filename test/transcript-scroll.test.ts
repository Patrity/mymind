import { describe, it, expect } from 'vitest'
import { isAtBottom, countNewSince } from '../app/utils/transcript-scroll'

describe('isAtBottom', () => {
  it('true within threshold of the bottom, false otherwise', () => {
    // gap = scrollHeight - scrollTop - clientHeight; at-bottom when gap <= threshold
    expect(isAtBottom({ scrollTop: 920, scrollHeight: 1000, clientHeight: 80 }, 40)).toBe(true)  // gap 0
    expect(isAtBottom({ scrollTop: 880, scrollHeight: 1000, clientHeight: 80 }, 40)).toBe(true)  // gap 40
    expect(isAtBottom({ scrollTop: 870, scrollHeight: 1000, clientHeight: 80 }, 40)).toBe(false) // gap 50
    expect(isAtBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 80 }, 40)).toBe(false) // gap 420
  })
})

describe('countNewSince', () => {
  it('counts items after the last-seen id (exclusive); 0 if last is newest/absent', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(countNewSince(items, 'a')).toBe(2)
    expect(countNewSince(items, 'c')).toBe(0)
    expect(countNewSince(items, null)).toBe(0)
    expect(countNewSince(items, 'zzz')).toBe(0)
  })
})
