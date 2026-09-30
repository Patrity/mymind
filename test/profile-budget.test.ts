import { describe, it, expect } from 'vitest'
import { estimateTokens, clampProfile, PROFILE_TOKEN_BUDGET } from '../server/lib/agent/profile-budget'

describe('profile budget', () => {
  it('estimates tokens as ceil(chars/4)', () => { expect(estimateTokens('')).toBe(0); expect(estimateTokens('abcde')).toBe(2) })
  it('leaves a short profile untouched', () => expect(clampProfile('hi')).toEqual({ text: 'hi', truncated: false }))
  it('cuts an over-budget profile at a line boundary and marks it', () => {
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i} xxxxxxxxxx`).join('\n')
    const r = clampProfile(long)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(PROFILE_TOKEN_BUDGET * 4 + 40)
    expect(r.text.endsWith('…(profile truncated)')).toBe(true)
    expect(r.text.split('\n').slice(-2, -1)[0]).toMatch(/^line \d+ x+$/)
  })
})
