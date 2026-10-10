import { describe, it, expect } from 'vitest'
import { classifyReplyText, tapbackSignal, OBSERVATION_WINDOW_MS } from '@mymind/core/lib/agent/signals/classify'
import type { Tapback } from '@mymind/core/lib/channels/types'

describe('classifyReplyText', () => {
  it('a stop phrase at the start of a sentence → said_stop', () => {
    expect(classifyReplyText('stop sending these')).toEqual(['said_stop'])
  })

  it('thanks with punctuation → said_thanks', () => {
    expect(classifyReplyText('thanks!')).toEqual(['said_thanks'])
  })

  it('a lexicon word inside another word does not match', () => {
    expect(classifyReplyText('stopwatch')).toEqual([])
    expect(classifyReplyText('nonstop')).toEqual([])
    expect(classifyReplyText('nicely done, thankful')).toEqual([])
  })

  it('a negated or hyphenated stop word is not a stop', () => {
    expect(classifyReplyText("don't stop")).toEqual([])
    expect(classifyReplyText('don’t stop these')).toEqual([])
    expect(classifyReplyText('Do NOT stop, this is great')).toEqual([])
    expect(classifyReplyText('never stop')).toEqual([])
    expect(classifyReplyText('non-stop updates')).toEqual([])
    expect(classifyReplyText('a stop-gap')).toEqual([])
    expect(classifyReplyText('not too many')).toEqual([])
  })

  it('a negated thanks word is not thanks', () => {
    expect(classifyReplyText('not helpful')).toEqual([])
    expect(classifyReplyText('no thanks')).toEqual([])
  })

  it('a negation word that is part of another word does not negate', () => {
    expect(classifyReplyText('piano stop')).toEqual(['said_stop'])
    expect(classifyReplyText('knot stop')).toEqual(['said_stop'])
  })

  it('the stop phrases that contain a negation still count', () => {
    expect(classifyReplyText("don't send these")).toEqual(['said_stop'])
    expect(classifyReplyText('not useful')).toEqual(['said_stop'])
  })

  it('several thanks phrases → one said_thanks, no duplicates', () => {
    expect(classifyReplyText('Thank you, perfect')).toEqual(['said_thanks'])
  })

  it('is case-insensitive and matches multi-word phrases across extra whitespace', () => {
    expect(classifyReplyText('NOT   useful at all')).toEqual(['said_stop'])
    expect(classifyReplyText('Too many of these')).toEqual(['said_stop'])
    expect(classifyReplyText('UNSUBSCRIBE')).toEqual(['said_stop'])
  })

  it("matches don't send with a straight, curly or missing apostrophe", () => {
    expect(classifyReplyText("don't send me this")).toEqual(['said_stop'])
    expect(classifyReplyText('don’t send me this')).toEqual(['said_stop'])
    expect(classifyReplyText('dont send me this')).toEqual(['said_stop'])
  })

  it('both lexicons can match one reply (stop first)', () => {
    expect(classifyReplyText('thanks, but please stop')).toEqual(['said_stop', 'said_thanks'])
  })

  it('every thanks word counts on its own', () => {
    for (const w of ['thanks', 'thank you', 'helpful', 'perfect', 'nice']) {
      expect(classifyReplyText(`that was ${w}`)).toEqual(['said_thanks'])
    }
  })

  it('plain text → nothing', () => {
    expect(classifyReplyText('what is on my calendar tomorrow?')).toEqual([])
    expect(classifyReplyText('')).toEqual([])
  })
})

describe('tapbackSignal', () => {
  it('maps every Tapback value', () => {
    const all: Record<Tapback, ReturnType<typeof tapbackSignal>> = {
      love: 'tapback_positive',
      like: 'tapback_positive',
      laugh: 'tapback_positive',
      emphasize: 'tapback_positive',
      dislike: 'tapback_negative',
      question: null
    }
    for (const [t, want] of Object.entries(all)) expect(tapbackSignal(t as Tapback)).toBe(want)
  })
})

describe('OBSERVATION_WINDOW_MS', () => {
  it('is two hours', () => {
    expect(OBSERVATION_WINDOW_MS).toBe(2 * 60 * 60 * 1000)
  })
})
