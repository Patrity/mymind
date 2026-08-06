import { describe, it, expect } from 'vitest'
import { applyImageEmbeds, redactImageUrlsForModel, sanitizedOffset } from './image-embed'

const img = (id: string) => ({ id, url: `/api/images/${id}/raw`, alt: 'a cat' })

describe('applyImageEmbeds', () => {
  it('appends a server embed and strips any model-authored /api/images embed', () => {
    const text = 'Here you go: ![hallucinated](/api/images/HALLUCINATED/raw)'
    const { content, appended } = applyImageEmbeds(text, [img('real1')])
    expect(content).not.toContain('HALLUCINATED')
    expect(content).toContain('![a cat](/api/images/real1/raw)')
    expect(appended).toContain('![a cat](/api/images/real1/raw)')
  })

  it('also strips a model-authored markdown LINK to /api/images', () => {
    const { content } = applyImageEmbeds('see [here](/api/images/x/raw)', [img('real1')])
    expect(content).not.toContain('/api/images/x/raw')
    expect(content).toContain('/api/images/real1/raw')
  })

  it('no images -> returns text unchanged, empty appended', () => {
    expect(applyImageEmbeds('hello', [])).toEqual({ content: 'hello', appended: '' })
  })

  it('strips a stray [image] marker the model copied from history, even with no images', () => {
    // Regression: the model imitated the history [image] marker as its reply and called no tool.
    expect(applyImageEmbeds('[image]', [])).toEqual({ content: '', appended: '' })
    expect(applyImageEmbeds('Sure! [image]', []).content).toBe('Sure!')
  })
})

describe('redactImageUrlsForModel', () => {
  it('REMOVES a server image embed entirely (no marker for the model to copy)', () => {
    const out = redactImageUrlsForModel('![a cat in a top hat](/api/images/abc-123/raw)')
    expect(out).toBe('')
    expect(out).not.toContain('/api/images')
    // no imitable marker at all — earlier `[generated image: <desc>]` and `[image]` were copied verbatim
    expect(out).not.toMatch(/\[image\]/i)
    expect(out).not.toMatch(/generated image/i)
  })

  it('keeps the model prose but drops the embed', () => {
    expect(redactImageUrlsForModel('Done — here is Travis ![x](/api/images/abc/raw)')).toBe('Done — here is Travis')
  })

  it('redacts a link-form /api/images url too', () => {
    expect(redactImageUrlsForModel('see [here](/api/images/x/raw)')).not.toContain('/api/images')
  })

  it('leaves normal prose untouched', () => {
    expect(redactImageUrlsForModel('Done — here is your image.')).toBe('Done — here is your image.')
  })
})

describe('sanitizedOffset', () => {
  // A tool-call offset is recorded mid-stream but is used to slice the PERSISTED content,
  // which applyImageEmbeds has trimmed and collapsed. Raw `assistantText.length` therefore
  // pointed into a string that no longer exists — the chip landed mid-word on resume.
  const split = (raw: string, at: number) => {
    const { content } = applyImageEmbeds(raw, [])
    const cut = Math.min(Math.max(at, 0), content.length)          // resume()'s clamp
    return [content.slice(0, cut), content.slice(cut)]
  }

  it('indexes the persisted content, not the raw stream', () => {
    const before = '\nOkay. '                 // leading \n is trimmed away on persist
    const raw = before + ' Done.'             // the double space collapses to one
    expect(applyImageEmbeds(raw, []).content).toBe('Okay. Done.')

    expect(split(raw, sanitizedOffset(before))).toEqual(['Okay. ', 'Done.'])
    expect(split(raw, before.length)).toEqual(['Okay. D', 'one.'])   // the old raw-length bug
  })

  it('handles a call that fires before any text at all', () => {
    expect(sanitizedOffset('')).toBe(0)
    expect(sanitizedOffset('\n\n  ')).toBe(0)
  })

  it('maps a multi-step turn to every one of its persisted boundaries', () => {
    const s1 = 'First.\n\n\n'                 // \n{3,} collapses to \n\n
    const s2 = s1 + 'Second.  '               // trailing double space collapses
    const raw = s2 + 'Third.'
    const { content } = applyImageEmbeds(raw, [])
    expect(content.slice(0, sanitizedOffset(s1))).toBe('First.\n\n')
    expect(content.slice(sanitizedOffset(s1), sanitizedOffset(s2))).toBe('Second. ')
    expect(content.slice(sanitizedOffset(s2))).toBe('Third.')
  })

  it('is not shifted by a stripped image embed earlier in the turn', () => {
    const before = 'Here: ![x](/api/images/abc/raw) and then '
    expect(sanitizedOffset(before)).toBe(applyImageEmbeds(before + 'more', []).content.indexOf('more'))
  })
})
