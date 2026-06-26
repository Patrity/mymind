import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractOutputImage, generateImage } from './comfy'
import type { ImageGenConfig } from './types'

const config: ImageGenConfig = {
  baseURL: 'http://rig:8188',
  unetName: 'u', clipName: 'c', vaeName: 'v',
  width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple', editStrength: 0.55
}

afterEach(() => { vi.unstubAllGlobals() })

describe('extractOutputImage', () => {
  it('pulls the first node output with images[]', () => {
    const history = { p1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }
    expect(extractOutputImage(history, 'p1')).toEqual({ filename: 'a.png', subfolder: '', type: 'output' })
  })
  it('returns null when the prompt id / outputs / images are absent', () => {
    expect(extractOutputImage({}, 'p1')).toBeNull()
    expect(extractOutputImage({ p1: { outputs: {} } }, 'p1')).toBeNull()
  })
  it('returns null when a node has an empty images[] array', () => {
    expect(extractOutputImage({ p1: { outputs: { '9': { images: [] } } } }, 'p1')).toBeNull()
  })
})

describe('generateImage', () => {
  it('submits, polls until outputs, fetches bytes, returns ok', async () => {
    const png = new Uint8Array([1, 2, 3]).buffer
    const $fetch = vi.fn()
      .mockResolvedValueOnce({ prompt_id: 'p1' })                                   // POST /prompt
      .mockResolvedValueOnce({ p1: { outputs: {} } })                               // 1st /history (not ready)
      .mockResolvedValueOnce({ p1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }) // 2nd /history
      .mockResolvedValueOnce(png)                                                   // GET /view -> ArrayBuffer
    vi.stubGlobal('$fetch', $fetch)
    const res = await generateImage({ prompt: 'a cat', seed: 5 }, { config, clientId: 'cid', pollIntervalMs: 1, maxWaitMs: 1000 })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.mime).toBe('image/png')
      expect(res.buffer.length).toBe(3)
      expect(res.meta.seed).toBe(5)
    }
    // POST body carried the graph + client_id
    const [firstUrl, firstOpts] = $fetch.mock.calls[0]!
    expect(firstUrl).toContain('/prompt')
    expect(firstOpts.body.client_id).toBe('cid')
  })

  it('returns { ok:false } (no throw) when ComfyUI is unreachable', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const res = await generateImage({ prompt: 'x', seed: 1 }, { config, pollIntervalMs: 1, maxWaitMs: 50 })
    expect(res).toEqual({ ok: false, error: expect.stringContaining('ECONNREFUSED') })
  })

  it('returns { ok:false, error } on poll timeout (outputs never arrive)', async () => {
    const $fetch = vi.fn()
      .mockResolvedValueOnce({ prompt_id: 'p1' })
      .mockResolvedValue({ p1: { outputs: {} } }) // never ready
    vi.stubGlobal('$fetch', $fetch)
    const res = await generateImage({ prompt: 'x', seed: 1 }, { config, pollIntervalMs: 1, maxWaitMs: 20 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/tim(e|ed) out/i)
  })

  it('returns { ok:false, error } when no baseURL is configured', async () => {
    const res = await generateImage({ prompt: 'x', seed: 1 }, { config: { ...config, baseURL: null } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/not configured/i)
  })

  it('aborts cleanly when the signal is already aborted', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ prompt_id: 'p1' }))
    const res = await generateImage({ prompt: 'x', seed: 1 }, { config, signal: AbortSignal.abort(), pollIntervalMs: 1, maxWaitMs: 50 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/abort/i)
  })

  // Regression: loadImageConfig() touches the DB. When NO config is passed in opts,
  // generateImage falls through to loadImageConfig(); a DB throw there must still
  // surface as { ok:false, error } (never escape) — the never-throws guarantee.
  it('returns { ok:false, error } (no throw) when loadImageConfig rejects', async () => {
    vi.resetModules()
    vi.doMock('./store', () => ({ loadImageConfig: vi.fn().mockRejectedValue(new Error('db down')) }))
    try {
      const { generateImage: generateImageMocked } = await import('./comfy')
      const res = await generateImageMocked({ prompt: 'x', seed: 1 }) // no config -> falls through to loadImageConfig()
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('db down')
    } finally {
      vi.doUnmock('./store')
      vi.resetModules()
    }
  })
})
