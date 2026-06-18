import { describe, it, expect } from 'vitest'
import { highlightTokens } from '../app/utils/highlight'

describe('highlightTokens', () => {
  it('splits text into matched/unmatched segments (case-insensitive)', () => {
    expect(highlightTokens('Blocked on PR #835 today', 'pr')).toEqual([
      { text: 'Blocked on ', match: false },
      { text: 'PR', match: true },
      { text: ' #835 today', match: false }
    ])
  })
  it('matches multiple tokens and escapes regex specials', () => {
    const segs = highlightTokens('cost is $5 (five)', '$5 five')
    expect(segs.filter(s => s.match).map(s => s.text.toLowerCase())).toEqual(['$5', 'five'])
  })
  it('returns one unmatched segment when nothing matches', () => {
    expect(highlightTokens('hello', 'zzz')).toEqual([{ text: 'hello', match: false }])
  })
  it('handles empty text', () => {
    expect(highlightTokens('', 'x')).toEqual([])
  })
})
