import { describe, it, expect } from 'vitest'
import { applyImageEmbeds, redactImageUrlsForModel } from './image-embed'

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
