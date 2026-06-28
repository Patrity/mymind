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
})

describe('redactImageUrlsForModel', () => {
  it('replaces a server image embed with a minimal, non-imitable placeholder (no url, no description)', () => {
    const out = redactImageUrlsForModel('![a cat in a top hat](/api/images/abc-123/raw)')
    expect(out).toBe('[image]')
    expect(out).not.toContain('/api/images')
    // the description must NOT survive — the model copied "generated image: <desc>" verbatim before
    expect(out).not.toContain('cat in a top hat')
    expect(out).not.toMatch(/generated image/i)
  })

  it('redacts a link-form /api/images url too', () => {
    expect(redactImageUrlsForModel('see [here](/api/images/x/raw)')).not.toContain('/api/images')
  })

  it('leaves normal prose untouched', () => {
    expect(redactImageUrlsForModel('Done — here is your image.')).toBe('Done — here is your image.')
  })
})
