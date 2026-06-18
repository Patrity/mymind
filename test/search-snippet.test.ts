import { describe, it, expect } from 'vitest'
import { makeSnippet } from '../server/lib/search/snippet'

describe('makeSnippet', () => {
  it('returns a window centred on the first matched token, ellipsized', () => {
    const text = 'Intro paragraph. The deploy is blocked on PR #835 pending review and CI. Footer.'
    const s = makeSnippet(text, 'PR #835 pending', 40)
    expect(s).toContain('PR #835 pending')
    expect(s.length).toBeLessThanOrEqual(42) // maxLen + the two ellipsis chars
    expect(s.startsWith('…')).toBe(true)      // window starts mid-text
  })
  it('collapses whitespace/newlines to single spaces', () => {
    expect(makeSnippet('a\n\n  b\tc', 'b', 100)).toBe('a b c')
  })
  it('falls back to the head when no token matches', () => {
    expect(makeSnippet('hello world of text', 'zzz', 11)).toBe('hello world…')
  })
  it('returns short text unchanged', () => {
    expect(makeSnippet('short', 'short', 160)).toBe('short')
  })
  it('ignores 1-char query tokens when locating the window', () => {
    const s = makeSnippet('aaaa target bbbb', 'a target', 160)
    expect(s).toContain('target')
  })
  it('keeps the window at the match when the matched phrase is longer than maxLen', () => {
    const text = 'alpha beta gamma delta epsilon zeta omega'
    const s = makeSnippet(text, 'gamma delta epsilon zeta', 10)
    expect(s).toContain('gamma')             // window starts at the match, not past it
    expect(s.length).toBeLessThanOrEqual(12) // maxLen + 2 ellipses
  })
})
