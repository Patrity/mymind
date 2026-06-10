// test/chunker.test.ts
import { describe, it, expect } from 'vitest'
import { SentenceChunker } from '../server/lib/voice/chunker'

describe('SentenceChunker', () => {
  it('emits on sentence-final punctuation', () => {
    const c = new SentenceChunker(5)
    expect(c.push('Hello there. How')).toEqual(['Hello there.'])
    expect(c.push(' are you?')).toEqual(['How are you?'])
    expect(c.flush()).toEqual([])
  })
  it('emits when minChars exceeded even without punctuation, and flushes the tail', () => {
    const c = new SentenceChunker(10)
    expect(c.push('abcdefghijk')).toEqual(['abcdefghijk'])
    expect(c.push(' tail')).toEqual([])
    expect(c.flush()).toEqual(['tail'])
  })
})
