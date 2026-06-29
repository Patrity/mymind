import { describe, it, expect, vi } from 'vitest'
import { buildUserMessageParts } from './attachments'

const readImg = vi.fn(async () => ({ bytes: Buffer.from([1, 2, 3]), mime: 'image/webp' }))

describe('buildUserMessageParts', () => {
  it('no attachments → plain string', async () => {
    expect(await buildUserMessageParts('hi', [], readImg)).toBe('hi')
  })
  it('image attachment → text + base64 image part', async () => {
    const out = await buildUserMessageParts('look', [{ id: 'g1', kind: 'image', mime: 'image/webp' }], readImg) as any[]
    expect(out[0]).toEqual({ type: 'text', text: 'look' })
    expect(out[1].type).toBe('image')
    expect(out[1].image).toMatch(/^data:image\/webp;base64,/)
  })
  it('PDF attachment → one image part per rendered page', async () => {
    const readPdf = vi.fn(async () => ({ bytes: Buffer.from([9]), mime: 'application/pdf' }))
    const renderPdf = vi.fn(async () => [
      { bytes: Buffer.from([1]), mime: 'image/webp' as const },
      { bytes: Buffer.from([2]), mime: 'image/webp' as const }
    ])
    const out = await buildUserMessageParts('summarize', [{ id: 'f1', kind: 'file', mime: 'application/pdf', name: 'a.pdf' }], readPdf, renderPdf) as any[]
    expect(out.filter(p => p.type === 'image').length).toBe(2)
    expect(out[1].image).toMatch(/^data:image\/webp;base64,/)
  })
  it('text file → text part with contents', async () => {
    const readTxt = vi.fn(async () => ({ bytes: Buffer.from('hello world', 'utf8'), mime: 'text/plain' }))
    const out = await buildUserMessageParts('what', [{ id: 't1', kind: 'file', mime: 'text/plain', name: 'n.txt' }], readTxt) as any[]
    const joined = out.filter(p => p.type === 'text').map(p => p.text).join('\n')
    expect(joined).toContain('hello world')
    expect(joined).toContain('n.txt')
  })
  it('PDF render yields nothing → unavailable note', async () => {
    const readPdf = vi.fn(async () => ({ bytes: Buffer.from([9]), mime: 'application/pdf' }))
    const out = await buildUserMessageParts('x', [{ id: 'f1', kind: 'file', mime: 'application/pdf', name: 'a.pdf' }], readPdf, async () => []) as any[]
    expect(out.some(p => p.type === 'text' && p.text.includes('[attachment unavailable'))).toBe(true)
  })
  it('unreadable attachment → text note, never throws', async () => {
    const out = await buildUserMessageParts('look', [{ id: 'x', kind: 'image', mime: 'image/webp' }], async () => null) as any[]
    expect(out.some(p => p.type === 'text' && p.text.includes('[attachment unavailable]'))).toBe(true)
  })
})
