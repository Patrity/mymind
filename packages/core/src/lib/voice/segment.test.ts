import { describe, it, expect } from 'vitest'
import { segment, SpeechChunker } from './segment'
import { toSpeakable } from './speakable'

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

  it('splits after a sentence-final period immediately following a number', () => {
    expect(segment('It costs 25. Then we go.', 999).segments)
      .toEqual(['It costs 25.', 'Then we go.'])
  })

  it('splits after a sentence-final period immediately following an IPv4 address', () => {
    expect(segment('The rig is at 192.168.2.25. Next thing.', 999).segments)
      .toEqual(['The rig is at 192.168.2.25.', 'Next thing.'])
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

  it('does not split an IPv4 address across a streaming push boundary', () => {
    const c = new SpeechChunker(999)
    expect(c.push('The rig is at 192.168.')).toEqual([])
    const out = c.push('2.25 is now up. Next.')
    expect(out).toEqual([
      toSpeakable('The rig is at 192.168.2.25 is now up.'),
      toSpeakable('Next.')
    ])
  })

  it('does not split a decimal across a streaming push boundary', () => {
    const c = new SpeechChunker(999)
    expect(c.push('Qwen 3.')).toEqual([])
    const out = c.push('6 is loaded.')
    expect(out).toEqual([toSpeakable('Qwen 3.6 is loaded.')])
  })
})

describe('segment: hard maximum length', () => {
  it('never emits a segment past maxChars, even for one run-on sentence whose only punctuation is at the very end', () => {
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore'.split(' ')
    let buf = ''
    let i = 0
    // Build a single "sentence" (one terminal period, at the very end) well past 3x
    // the default max (200) — the OLD one-shot minChars fallback only ever cut once
    // per call, so a run this long used to sail past 200 chars unbroken.
    while (buf.length < 650) { buf += words[i % words.length] + ' '; i++ }
    buf += 'done.'

    const r = segment(buf) // defaults: minChars=140, maxChars=200
    expect(r.segments.length).toBeGreaterThanOrEqual(3)
    for (const s of r.segments) expect(s.length).toBeLessThanOrEqual(205)
    expect(r.segments.at(-1)).toMatch(/done\.$/)
  })

  it('the hard cap is independent of an explicit minChars — still enforced even when minChars is effectively disabled', () => {
    const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa'.split(' ')
    let buf = ''
    let i = 0
    while (buf.length < 500) { buf += words[i % words.length] + ' '; i++ }
    buf += 'end.'

    const r = segment(buf, 999, 200) // minChars effectively off; maxChars still 200
    expect(r.segments.length).toBeGreaterThanOrEqual(2)
    for (const s of r.segments) expect(s.length).toBeLessThanOrEqual(205)
  })
})

describe('segment: short first segment (firstMax)', () => {
  it('cuts only the FIRST segment at firstMax, leaving later segments to use the normal caps', () => {
    const clause = (n: number) => 'w'.repeat(n)
    // Four long clauses, comma-separated, no terminal punctuation until the very end —
    // none of the boundaries land inside firstMax(60) except the very first comma at 30.
    const buf = `${clause(30)}, ${clause(30)}, ${clause(30)}, ${clause(30)}.`

    const r = segment(buf, 140, 200, 60)
    expect(r.segments.length).toBeGreaterThanOrEqual(2)
    // First segment cut at the FIRST comma (firstMax=60 reached mid-way through the
    // second clause) — not the later comma minChars(140) would have reached instead.
    expect(r.segments[0]).toBe(clause(30) + ',')
    expect(r.segments[1]!.length).toBeGreaterThan(r.segments[0]!.length)
  })

  it('does not shrink a naturally-short first sentence just because firstMax is set', () => {
    const r = segment('Hi there. This second sentence is deliberately much longer than firstMax so it is not clamped down to size.', 140, 200, 60)
    expect(r.segments[0]).toBe('Hi there.')
    expect(r.segments[1]!.length).toBeGreaterThan(60)
  })
})

describe('SpeechChunker: first-segment shaping end to end', () => {
  it('keeps the first segment of a turn short, and later segments are allowed to run longer', () => {
    const c = new SpeechChunker(140, 200, 60)
    const clause = (n: number) => 'w'.repeat(n)
    const out = c.push(`${clause(30)}, ${clause(30)}, ${clause(30)}, ${clause(30)}.`)
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out[0]!.length).toBeLessThanOrEqual(35)
    expect(out[1]!.length).toBeGreaterThan(out[0]!.length)
  })

  it('only shortens the actual first segment of the turn, not the first segment of every push() call', () => {
    const c = new SpeechChunker(140, 200, 60)
    const first = c.push('Short first bit. ')
    expect(first).toEqual(['Short first bit.'])
    // A later push()'s own "first" segment must NOT be re-clamped to firstMax — that
    // policy applies once, to the turn's actual first segment, already emitted above.
    const second = c.push('this second delta is a much longer run of text with no punctuation until it finally ends right here.')
    expect(second[0]!.length).toBeGreaterThan(60)
  })

  it('enforces maxChars end to end, even for one giant run-on delta', () => {
    const c = new SpeechChunker(140, 200, 60)
    const words = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ')
    const out = c.push(words + '.')
    expect(out.length).toBeGreaterThanOrEqual(2)
    for (const s of out) expect(s.length).toBeLessThanOrEqual(205)
  })
})
