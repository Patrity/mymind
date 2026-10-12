// Cycle 84 R3: the nonce pin store's non-consuming peek (the judge binds its gmail rule to the pin).
import { describe, it, expect } from 'vitest'
import { createNoncePinStore } from './approval-pins'

describe('createNoncePinStore.peek', () => {
  it('reads a live pin without consuming it; take still gets it once', () => {
    const s = createNoncePinStore<string>()
    s.remember('n1', 'v1')
    expect(s.peek('n1')).toBe('v1')
    expect(s.peek('n1')).toBe('v1')
    expect(s.take('n1')).toBe('v1')
    expect(s.peek('n1')).toBeUndefined()
  })
  it('an expired pin, an unknown nonce and an empty nonce read as undefined', () => {
    const s = createNoncePinStore<string>(-1)
    s.remember('n1', 'v1')
    expect(s.peek('n1')).toBeUndefined()
    expect(s.peek('nope')).toBeUndefined()
    expect(s.peek('')).toBeUndefined()
  })
})
