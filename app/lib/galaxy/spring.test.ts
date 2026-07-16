import { describe, it, expect } from 'vitest'
import { makeSpring, stepSpring } from './spring'

describe('spring', () => {
  it('converges to its target', () => {
    const s = makeSpring(0); s.t = 1
    for (let i = 0; i < 400; i++) stepSpring(s)
    expect(Math.abs(s.c - 1)).toBeLessThan(1e-3)
    expect(Math.abs(s.v)).toBeLessThan(1e-3)
  })
  it('overshoots at least once (bouncy)', () => {
    const s = makeSpring(0); s.t = 1
    let max = 0
    for (let i = 0; i < 400; i++) { stepSpring(s); max = Math.max(max, s.c) }
    expect(max).toBeGreaterThan(1) // overshoot past target
  })
})
