import { describe, it, expect, vi, afterEach } from 'vitest'
import { editImage, uploadSourceImage } from './comfy'
import type { ImageGenConfig } from './types'

const config: ImageGenConfig = {
  baseURL: 'http://rig:8188', unetName: 'u', clipName: 'c', vaeName: 'v',
  width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple', editStrength: 0.55,
  editUnetName: 'qwen_image_edit_2509_fp8_e4m3fn_lightning4.safetensors',
  editSteps: 4, editCfg: 1.0,
  editUnetQualityName: 'qwen_image_edit_2509_fp8_e4m3fn.safetensors',
  editStepsQuality: 20, editCfgQuality: 2.5, editShift: 3.0
}
const src = { sourceBytes: Buffer.from([9, 9, 9]), sourceMime: 'image/webp' }

afterEach(() => { vi.unstubAllGlobals() })

describe('editImage', () => {
  it('uploads the source, submits the Qwen edit graph, polls, fetches bytes, returns ok', async () => {
    const png = new Uint8Array([1, 2, 3]).buffer
    const $fetch = vi.fn()
      .mockResolvedValueOnce({ name: 'src.png', subfolder: '', type: 'input' })       // POST /upload/image
      .mockResolvedValueOnce({ prompt_id: 'p1' })                                      // POST /prompt
      .mockResolvedValueOnce({ p1: { outputs: { '9': { images: [{ filename: 'o.png', subfolder: '', type: 'output' }] } } } })
      .mockResolvedValueOnce(png)
    vi.stubGlobal('$fetch', $fetch)
    const res = await editImage({ ...src, prompt: 'make it a cowboy hat', seed: 5 }, { config, clientId: 'cid', pollIntervalMs: 1, maxWaitMs: 1000 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.buffer.length).toBe(3)
    expect(String($fetch.mock.calls[0]?.[0])).toContain('/upload/image')
    // the submitted /prompt body carries the Qwen edit graph (fast model by default)
    const graph = ($fetch.mock.calls[1]?.[1] as { body: { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> } }).body.prompt
    expect(graph['111']!.class_type).toBe('TextEncodeQwenImageEditPlus')
    expect(graph['37']!.inputs.unet_name).toBe(config.editUnetName)
    // fast path uses the fast steps/cfg (guards against always-quality regression)
    expect(graph['3']!.inputs.steps).toBe(config.editSteps)
    expect(graph['3']!.inputs.cfg).toBe(config.editCfg)
  })

  it('quality:true submits the unmerged quality model', async () => {
    const png = new Uint8Array([1]).buffer
    const $fetch = vi.fn()
      .mockResolvedValueOnce({ name: 'src.png', subfolder: '', type: 'input' })
      .mockResolvedValueOnce({ prompt_id: 'p1' })
      .mockResolvedValueOnce({ p1: { outputs: { '9': { images: [{ filename: 'o.png', subfolder: '', type: 'output' }] } } } })
      .mockResolvedValueOnce(png)
    vi.stubGlobal('$fetch', $fetch)
    await editImage({ ...src, prompt: 'x', seed: 1 }, { config, quality: true, pollIntervalMs: 1, maxWaitMs: 1000 })
    const graph = ($fetch.mock.calls[1]?.[1] as { body: { prompt: Record<string, { inputs: Record<string, unknown> }> } }).body.prompt
    expect(graph['37']!.inputs.unet_name).toBe(config.editUnetQualityName)
    expect(graph['3']!.inputs.steps).toBe(20)
  })

  it('returns { ok:false } (no throw) when the upload fails', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const res = await editImage({ ...src, prompt: 'x', seed: 1 }, { config, pollIntervalMs: 1, maxWaitMs: 50 })
    expect(res).toEqual({ ok: false, error: expect.stringContaining('ECONNREFUSED') })
  })

  it('returns { ok:false } when no baseURL is configured', async () => {
    const res = await editImage({ ...src, prompt: 'x', seed: 1 }, { config: { ...config, baseURL: null } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/not configured/i)
  })
})

describe('uploadSourceImage', () => {
  it('returns { ok:false } when no baseURL is configured', async () => {
    const res = await uploadSourceImage(Buffer.from([1]), 'x.png', { config: { ...config, baseURL: null } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/not configured/i)
  })

  it('returns { ok:false } when the upload response has no name', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({}))
    const res = await uploadSourceImage(Buffer.from([1]), 'x.png', { config })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/no filename/i)
  })

  it('prefixes the subfolder when present, else returns the bare name', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ name: 'a.png', subfolder: 'sub', type: 'input' }))
    const withSub = await uploadSourceImage(Buffer.from([1]), 'x.png', { config })
    expect(withSub).toEqual({ ok: true, name: 'sub/a.png' })

    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ name: 'a.png', subfolder: '', type: 'input' }))
    const noSub = await uploadSourceImage(Buffer.from([1]), 'x.png', { config })
    expect(noSub).toEqual({ ok: true, name: 'a.png' })
  })
})
