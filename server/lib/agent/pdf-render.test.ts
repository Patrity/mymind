import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderPdfToImages } from './pdf-render'

const sample = readFileSync(fileURLToPath(new URL('./__fixtures__/sample.pdf', import.meta.url)))
const isWebp = (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'

describe('renderPdfToImages', () => {
  it('renders a one-page PDF to a webp image', async () => {
    const out = await renderPdfToImages(sample)
    expect(out.length).toBe(1)
    expect(out[0]!.mime).toBe('image/webp')
    expect(isWebp(out[0]!.bytes)).toBe(true)
  })
  it('respects maxPages', async () => {
    const out = await renderPdfToImages(sample, { maxPages: 0 })
    expect(out.length).toBe(0)
  })
  it('returns [] for a non-PDF buffer (never throws)', async () => {
    const out = await renderPdfToImages(Buffer.from('not a pdf'))
    expect(out).toEqual([])
  })
})
