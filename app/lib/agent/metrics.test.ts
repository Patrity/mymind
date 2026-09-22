import { describe, it, expect } from 'vitest'
import { rateLabel, durationLabel } from './metrics'

describe('rateLabel', () => {
  it('computes output tokens over the generating window, excluding the wait for the first token', () => {
    // 300 tokens, 5s total, 1s of it waiting → 300 / 4s = 75
    expect(rateLabel({ outputTokens: 300, durationMs: 5000, ttftMs: 1000 })).toBe('75.0 tok/s')
  })

  it('is empty when there is no timing at all', () => {
    expect(rateLabel({ outputTokens: 300 })).toBe('')
    expect(rateLabel(null)).toBe('')
    expect(rateLabel(undefined)).toBe('')
  })

  it('is empty rather than Infinity when the window is zero', () => {
    expect(rateLabel({ outputTokens: 300, durationMs: 1000, ttftMs: 1000 })).toBe('')
  })

  it('is empty rather than NaN when ttft exceeds duration', () => {
    expect(rateLabel({ outputTokens: 300, durationMs: 500, ttftMs: 900 })).toBe('')
  })

  it('is empty for a turn that produced no output', () => {
    expect(rateLabel({ outputTokens: 0, durationMs: 5000, ttftMs: 1000 })).toBe('')
  })

  it('treats a missing ttft as zero wait rather than discarding the measurement', () => {
    expect(rateLabel({ outputTokens: 100, durationMs: 2000 })).toBe('50.0 tok/s')
  })

  it('is empty rather than "NaN tok/s" for a corrupt outputTokens', () => {
    expect(rateLabel({ outputTokens: NaN, durationMs: 5000, ttftMs: 1000 })).toBe('')
  })

  it('is empty rather than "NaN tok/s" for a corrupt durationMs', () => {
    expect(rateLabel({ outputTokens: 300, durationMs: NaN, ttftMs: 1000 })).toBe('')
  })

  it('is empty rather than "NaN tok/s" for a corrupt ttftMs', () => {
    expect(rateLabel({ outputTokens: 300, durationMs: 5000, ttftMs: NaN })).toBe('')
  })
})

describe('durationLabel', () => {
  it('uses seconds with one decimal above a second', () => {
    expect(durationLabel({ durationMs: 4200 })).toBe('4.2s')
  })

  it('uses whole milliseconds below a second', () => {
    expect(durationLabel({ durationMs: 820 })).toBe('820ms')
  })

  it('treats exactly 1000ms as the seconds boundary, not the milliseconds branch', () => {
    expect(durationLabel({ durationMs: 1000 })).toBe('1.0s')
  })

  it('is empty when nothing was recorded', () => {
    expect(durationLabel({})).toBe('')
    expect(durationLabel(null)).toBe('')
  })

  it('is empty rather than "NaNms" for a corrupt durationMs', () => {
    expect(durationLabel({ durationMs: NaN })).toBe('')
  })
})
