import { describe, it, expect } from 'vitest'
import { isAtBottom, countNewSince } from '../app/utils/transcript-scroll'

describe('agent transcript scroll helpers', () => {
  it('reports not-at-bottom for the measured regression case', () => {
    // The live defect: a 3338px reply in an 879px box with scrollTop stuck at 0.
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 3338, clientHeight: 879 })).toBe(false)
  })

  it('reports at-bottom once pinned', () => {
    expect(isAtBottom({ scrollTop: 2459, scrollHeight: 3338, clientHeight: 879 })).toBe(true)
  })

  it('counts entries added after the last seen one', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    expect(countNewSince(items, 'b')).toBe(2)
    expect(countNewSince(items, 'd')).toBe(0)
    expect(countNewSince(items, null)).toBe(0)
  })
})
