import { describe, it, expect } from 'vitest'
import { buildResumeTranscript, type ResumeMessage } from './transcript'
// The offset a resumed message is sliced at is PRODUCED here, on the server, and CONSUMED
// above — the seam this file exists to test. Pure module, no server runtime pulled in.
import { applyImageEmbeds, sanitizedOffset } from '../../../server/lib/agent/image-embed'

type ToolCall = NonNullable<ResumeMessage['toolCalls']>[number]
const tc = (o: Partial<ToolCall> = {}): ToolCall => ({ name: 'web_search', summary: 'searched', callId: 'c1', textOffset: 0, ...o })
const msg = (o: Partial<ResumeMessage> = {}): ResumeMessage => ({ id: 'm1', role: 'assistant', content: 'hello', ...o })

describe('buildResumeTranscript', () => {
  it('interleaves text → chip → text at each offset', () => {
    const entries = buildResumeTranscript([msg({
      content: 'Looking. Found it.',
      toolCalls: [tc({ textOffset: 'Looking. '.length })]
    })])
    expect(entries.map(e => [e.role, e.text])).toEqual([
      ['assistant', 'Looking. '], ['tool', ''], ['assistant', 'Found it.']
    ])
    expect(entries[1]!.summary).toBe('searched')
  })

  it('a server-recorded offset splits the persisted content on a word boundary', () => {
    // Stream "\nOkay. " → tool fires → " Done.". applyImageEmbeds trims the leading newline
    // and collapses the double space, so the RAW offset (7) pointed one char too far right.
    const before = '\nOkay. '
    const { content } = applyImageEmbeds(before + ' Done.', [])
    expect(content).toBe('Okay. Done.')

    const good = buildResumeTranscript([msg({ content, toolCalls: [tc({ textOffset: sanitizedOffset(before) })] })])
    expect(good.map(e => e.text)).toEqual(['Okay. ', '', 'Done.'])

    // …and this is what the pre-fix raw offset rendered: a chip in the middle of a word.
    const bad = buildResumeTranscript([msg({ content, toolCalls: [tc({ textOffset: before.length })] })])
    expect(bad.map(e => e.text)).toEqual(['Okay. D', '', 'one.'])
  })

  it('falls back to chips-first for a legacy row with no offsets', () => {
    const entries = buildResumeTranscript([msg({
      content: 'done', toolCalls: [{ name: 'x', summary: 's', undoToken: 'u' }]
    })])
    expect(entries.map(e => e.role)).toEqual(['tool', 'assistant'])
    expect(entries[1]!.text).toBe('done')
    expect(entries[0]!.undoToken).toBe('u')
  })

  it('falls back — without dropping any record — when offsets are MIXED', () => {
    const entries = buildResumeTranscript([msg({
      content: 'done', toolCalls: [tc({ textOffset: 2 }), { name: 'legacy', summary: 's' }]
    })])
    // Chips-first fallback, both records kept, and the text left WHOLE — taking the
    // structured branch here would slice at the offset-less record's undefined offset.
    expect(entries.map(e => [e.role, e.name ?? e.text])).toEqual([
      ['tool', 'web_search'], ['tool', 'legacy'], ['assistant', 'done']
    ])
  })

  it('leaves no empty trailing bubble when the chip ends the reply', () => {
    const entries = buildResumeTranscript([msg({ content: 'All set.', toolCalls: [tc({ textOffset: 8 })] })])
    expect(entries.map(e => e.role)).toEqual(['assistant', 'tool'])
  })

  it('keeps the trailing bubble when it still carries reasoning or attachments', () => {
    const withReasoning = buildResumeTranscript([msg({ content: 'All set.', reasoning: 'hmm', toolCalls: [tc({ textOffset: 8 })] })])
    expect(withReasoning.at(-1)).toMatchObject({ role: 'assistant', text: '', reasoning: 'hmm' })

    const withAttachments = buildResumeTranscript([msg({
      content: 'All set.', attachments: [{ id: 'a', kind: 'image', mime: 'image/png' }], toolCalls: [tc({ textOffset: 8 })]
    })])
    expect(withAttachments.at(-1)!.attachments).toHaveLength(1)
  })

  it('clamps an out-of-range or negative offset instead of producing junk slices', () => {
    // Content longer than |negative offset|, so an UNCLAMPED slice(-5) would silently
    // return the tail ('fghij') instead of the whole message.
    const entries = buildResumeTranscript([msg({
      content: 'abcdefghij', toolCalls: [tc({ callId: 'a', textOffset: -5 }), tc({ callId: 'b', textOffset: 9999 })]
    })])
    expect(entries.map(e => [e.role, e.text])).toEqual([
      ['tool', ''], ['assistant', 'abcdefghij'], ['tool', '']
    ])
  })

  it('passes user turns and tool-free assistant turns straight through', () => {
    const entries = buildResumeTranscript([
      { id: 'u1', role: 'user', content: 'hi', toolCalls: null },
      { id: 'a1', role: 'assistant', content: 'hey', toolCalls: null }
    ])
    expect(entries.map(e => [e.id, e.role, e.text])).toEqual([['u1', 'user', 'hi'], ['a1', 'assistant', 'hey']])
  })
})
