import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the heavy deps the handler calls.
vi.mock('../server/lib/imagegen/comfy', () => ({ generateImage: vi.fn() }))
vi.mock('../server/services/images', () => ({
  createGeneratedImage: vi.fn(),
  deleteImage: vi.fn(),
  serveUrl: (row: { id: string }) => `/api/images/${row.id}/raw`
}))
vi.mock('../server/utils/live-bus', () => ({ publishChange: vi.fn() }))

import { agentTools } from '../server/lib/agent/tools'
import { generateImage } from '../server/lib/imagegen/comfy'
import { createGeneratedImage, deleteImage } from '../server/services/images'
import { publishChange } from '../server/utils/live-bus'

const tool = agentTools.find(t => t.name === 'generate_image')!
const ctx = { signal: new AbortController().signal }

beforeEach(() => { vi.clearAllMocks() })

describe('generate_image tool', () => {
  it('is registered, create-kind, and not dangerous (rides default toolset + MCP)', () => {
    expect(tool).toBeTruthy()
    expect(tool.kind).toBe('create')
    expect(tool.dangerous).toBeFalsy()
  })

  it('generates, persists, publishes, and returns id+url (with undo)', async () => {
    ;(generateImage as any).mockResolvedValue({ ok: true, buffer: Buffer.from([1]), mime: 'image/png', meta: { seed: 7, width: 1024, height: 1024, steps: 20, cfg: 2.5 } })
    ;(createGeneratedImage as any).mockResolvedValue({ id: 'img1', isPublic: false, publicSlug: null })
    const exec = await tool.handler({ prompt: 'a red bicycle' }, ctx)
    const result = exec.result as { images: { id: string; url: string; seed: number }[] }
    expect(result.images[0].id).toBe('img1')
    expect(result.images[0].url).toBe('/api/images/img1/raw')
    expect(result.images[0].seed).toBe(7)
    expect(createGeneratedImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', { prompt: 'a red bicycle' })
    expect(publishChange).toHaveBeenCalledWith({ resource: 'image', action: 'created', id: 'img1' })
    await exec.undo!()
    expect(deleteImage).toHaveBeenCalledWith('img1')
    expect(publishChange).toHaveBeenCalledWith({ resource: 'image', action: 'deleted', id: 'img1' })
  })

  it('returns a clean error result (no throw) when generation fails', async () => {
    ;(generateImage as any).mockResolvedValue({ ok: false, error: 'ECONNREFUSED' })
    const exec = await tool.handler({ prompt: 'x' }, ctx)
    expect((exec.result as { ok: boolean }).ok).toBe(false)
    expect(exec.summary).toMatch(/failed/i)
    expect(createGeneratedImage).not.toHaveBeenCalled()
  })

  it('generates n images sequentially', async () => {
    ;(generateImage as any).mockResolvedValue({ ok: true, buffer: Buffer.from([1]), mime: 'image/png', meta: { seed: 1, width: 1024, height: 1024, steps: 20, cfg: 2.5 } })
    ;(createGeneratedImage as any)
      .mockResolvedValueOnce({ id: 'a', isPublic: false, publicSlug: null })
      .mockResolvedValueOnce({ id: 'b', isPublic: false, publicSlug: null })
    const exec = await tool.handler({ prompt: 'x', n: 2 }, ctx)
    expect((exec.result as { images: unknown[] }).images.length).toBe(2)
    expect(generateImage).toHaveBeenCalledTimes(2)
  })

  it('partial success: keeps the first image when a later generation fails (with undo)', async () => {
    ;(generateImage as any)
      .mockResolvedValueOnce({ ok: true, buffer: Buffer.from([1]), mime: 'image/png', meta: { seed: 3, width: 1024, height: 1024, steps: 20, cfg: 2.5 } })
      .mockResolvedValueOnce({ ok: false, error: 'boom' })
    ;(createGeneratedImage as any).mockResolvedValueOnce({ id: 'a', isPublic: false, publicSlug: null })
    const exec = await tool.handler({ prompt: 'x', n: 2 }, ctx)
    const result = exec.result as { images: { id: string }[] }
    expect(result.images.length).toBe(1)
    expect(result.images[0].id).toBe('a')
    expect(createGeneratedImage).toHaveBeenCalledTimes(1)
    expect(exec.undo).toBeTypeOf('function')
    await exec.undo!()
    expect(deleteImage).toHaveBeenCalledWith('a')
    expect(deleteImage).toHaveBeenCalledTimes(1)
  })

  it('aborts before generating when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const abortedCtx = { signal: ac.signal }
    const exec = await tool.handler({ prompt: 'x', n: 2 }, abortedCtx)
    expect(generateImage).not.toHaveBeenCalled()
    expect((exec.result as { images: unknown[] }).images.length).toBe(0)
  })
})
