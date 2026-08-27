import { describe, it, expect } from 'vitest'
import { segment, SpeechChunker } from './segment'

describe('segment', () => {
  it('splits on sentence-final punctuation followed by space', () => {
    expect(segment('One thing. Two things! Three?', 999)).toEqual({
      segments: ['One thing.', 'Two things!', 'Three?'],
      tail: ''
    })
  })

  it('retains an unterminated tail', () => {
    expect(segment('Done. And then I', 999)).toEqual({ segments: ['Done.'], tail: ' And then I' })
  })

  it('does NOT split inside an IPv4 address', () => {
    const r = segment('The rig is at 192.168.2.25 today. Next.', 999)
    expect(r.segments).toEqual(['The rig is at 192.168.2.25 today.', 'Next.'])
  })

  it('does NOT split inside a decimal', () => {
    expect(segment('Qwen 3.6 is loaded. Good.', 999).segments)
      .toEqual(['Qwen 3.6 is loaded.', 'Good.'])
  })

  it('does NOT split after a known abbreviation', () => {
    expect(segment('Ask Dr. Smith about it. Then go.', 999).segments)
      .toEqual(['Ask Dr. Smith about it.', 'Then go.'])
    expect(segment('Use a tool, e.g. search_docs, first. Then reply.', 999).segments)
      .toEqual(['Use a tool, e.g. search_docs, first.', 'Then reply.'])
  })

  it('does NOT split inside a dotted identifier or file extension', () => {
    expect(segment('Open useVoice.ts now. Done.', 999).segments)
      .toEqual(['Open useVoice.ts now.', 'Done.'])
  })

  it('does NOT split on an ellipsis mid-sentence', () => {
    expect(segment('Let me check... it is there. Yes.', 999).segments)
      .toEqual(['Let me check... it is there.', 'Yes.'])
  })

  it('treats a newline as a hard boundary', () => {
    expect(segment('First line\nSecond line\n', 999).segments)
      .toEqual(['First line', 'Second line'])
  })

  it('breaks at the last clause boundary when it exceeds minChars', () => {
    const long = 'this clause is quite long indeed, and this second clause pushes it over the cap and keeps going'
    const r = segment(long, 40)
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0]).toBe('this clause is quite long indeed,')
    expect(r.tail).toBe(' and this second clause pushes it over the cap and keeps going')
  })

  it('falls back to the last space when there is no clause boundary', () => {
    const long = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk'
    const r = segment(long, 20)
    expect(r.segments[0]!.endsWith('dddd') || r.segments[0]!.endsWith('eeee')).toBe(true)
    expect(r.segments[0]!.length).toBeLessThanOrEqual(20 + 5)
  })

  it('never emits an empty segment', () => {
    expect(segment('...   \n\n  ', 999).segments.every(s => s.trim().length > 0)).toBe(true)
  })
})

describe('SpeechChunker', () => {
  it('sanitizes only completed segments and holds the tail', () => {
    const c = new SpeechChunker(999)
    expect(c.push('Here are your **6 ')).toEqual([])
    expect(c.push('active projects**. ')).toEqual(['Here are your 6 active projects.'])
    expect(c.push('More to come')).toEqual([])
    expect(c.flush()).toEqual(['More to come'])
  })

  it('does not emit half a markdown marker when a delta splits one', () => {
    const c = new SpeechChunker(999)
    c.push('that is **')
    c.push('bold')
    const out = c.push('** text. ')
    expect(out).toEqual(['that is bold text.'])
    expect(out.join('')).not.toContain('*')
  })

  it('drops a segment that sanitizes to nothing', () => {
    const c = new SpeechChunker(999)
    expect(c.push('```\ncode\n```\n')).toEqual([])
  })

  it('does not fragment an IP across synth calls', () => {
    const c = new SpeechChunker(999)
    c.push('The rig is at 192.168.2.25 and it works. ')
    // one segment, not four
    expect(c.flush()).toEqual([])
  })
})
