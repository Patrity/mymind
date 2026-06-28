import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/lib/imagegen/comfy', () => ({ editImage: vi.fn(), generateImage: vi.fn() }))
vi.mock('../server/services/images', () => ({
  resolveSourceImageId: vi.fn(),
  getImageBytes: vi.fn(),
  createGeneratedImage: vi.fn(),
  deleteImage: vi.fn(),
  serveUrl: (row: { id: string }) => `/api/images/${row.id}/raw`
}))
vi.mock('../server/utils/live-bus', () => ({ publishChange: vi.fn() }))

import { agentTools } from '../server/lib/agent/tools'
import { editImage } from '../server/lib/imagegen/comfy'
import { resolveSourceImageId, getImageBytes, createGeneratedImage, deleteImage } from '../server/services/images'
import { publishChange } from '../server/utils/live-bus'

const tool = agentTools.find(t => t.name === 'edit_image')!
const ctx = { signal: new AbortController().signal }
beforeEach(() => { vi.clearAllMocks() })

describe('edit_image tool', () => {
  it('is registered, create-kind, not dangerous', () => {
    expect(tool).toBeTruthy()
    expect(tool.kind).toBe('create')
    expect(tool.dangerous).toBeFalsy()
  })

  it('edits the resolved source, persists generated+edited, returns image_id + display (no url to model)', async () => {
    ;(resolveSourceImageId as any).mockResolvedValue('src1')
    ;(getImageBytes as any).mockResolvedValue({ bytes: Buffer.from([1]), mime: 'image/webp' })
    ;(editImage as any).mockResolvedValue({ ok: true, buffer: Buffer.from([2]), mime: 'image/png', meta: { seed: 9, width: 1024, height: 1024, steps: 20, cfg: 2.5 } })
    ;(createGeneratedImage as any).mockResolvedValue({ id: 'edit1', isPublic: false, publicSlug: null })
    const exec = await tool.handler({ prompt: 'make the hat blue' }, ctx)
    expect((exec.result as Record<string, unknown>).url).toBeUndefined()
    expect((exec.result as { image_id: string }).image_id).toBe('edit1')
    expect((exec as { display: { images: { url: string }[] } }).display.images[0].url).toBe('/api/images/edit1/raw')
    expect(resolveSourceImageId).toHaveBeenCalledWith(null)
    expect(createGeneratedImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', { prompt: 'make the hat blue', tags: ['generated', 'edited'] })
    expect(publishChange).toHaveBeenCalledWith({ resource: 'image', action: 'created', id: 'edit1' })
    await exec.undo!()
    expect(deleteImage).toHaveBeenCalledWith('edit1')
    expect(publishChange).toHaveBeenCalledWith({ resource: 'image', action: 'deleted', id: 'edit1' })
  })

  it('forwards quality flag to editImage', async () => {
    ;(resolveSourceImageId as any).mockResolvedValue('src1')
    ;(getImageBytes as any).mockResolvedValue({ bytes: Buffer.from([1]), mime: 'image/webp' })
    ;(editImage as any).mockResolvedValue({ ok: true, buffer: Buffer.from([2]), mime: 'image/png', meta: { seed: 9, width: 1024, height: 1024, steps: 20, cfg: 2.5 } })
    ;(createGeneratedImage as any).mockResolvedValue({ id: 'e2', isPublic: false, publicSlug: null })
    await tool.handler({ prompt: 'make it a cowboy hat', quality: true }, ctx)
    expect((editImage as any).mock.calls.at(-1)[1].quality).toBe(true)
  })

  it('clean error when there is no source image to edit', async () => {
    ;(resolveSourceImageId as any).mockResolvedValue(null)
    const exec = await tool.handler({ prompt: 'x' }, ctx)
    expect((exec.result as { ok: boolean }).ok).toBe(false)
    expect(editImage).not.toHaveBeenCalled()
  })

  it('clean error when the resolved source has no bytes', async () => {
    ;(resolveSourceImageId as any).mockResolvedValue('src1')
    ;(getImageBytes as any).mockResolvedValue(null)
    const exec = await tool.handler({ prompt: 'x' }, ctx)
    expect((exec.result as { ok: boolean }).ok).toBe(false)
    expect(editImage).not.toHaveBeenCalled()
  })

  it('clean error (no throw) when editImage fails', async () => {
    ;(resolveSourceImageId as any).mockResolvedValue('src1')
    ;(getImageBytes as any).mockResolvedValue({ bytes: Buffer.from([1]), mime: 'image/webp' })
    ;(editImage as any).mockResolvedValue({ ok: false, error: 'ECONNREFUSED' })
    const exec = await tool.handler({ prompt: 'x' }, ctx)
    expect((exec.result as { ok: boolean }).ok).toBe(false)
    expect(createGeneratedImage).not.toHaveBeenCalled()
  })

  it('never throws — converts a DB throw during source resolution to a clean error', async () => {
    ;(resolveSourceImageId as any).mockRejectedValue(new Error('db down'))
    const exec = await tool.handler({ prompt: 'x' }, ctx)
    expect((exec.result as { ok: boolean }).ok).toBe(false)
    expect(editImage).not.toHaveBeenCalled()
  })
})
