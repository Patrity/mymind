import { describe, it, expect } from 'vitest'
import { defaultImageConfig, mergeImageConfig, parseImageConfigInput } from './store'

describe('defaultImageConfig', () => {
  it('defaults baseURL to null and carries the Qwen filenames + sane sampler defaults', () => {
    const d = defaultImageConfig()
    expect(d.baseURL).toBeNull()
    expect(d.unetName).toMatch(/qwen_image_fp8/)
    expect(d.width).toBe(1024)
    expect(d.steps).toBe(20)
    expect(d.cfg).toBe(2.5)
    expect(d.sampler).toBe('euler')
    expect(d.scheduler).toBe('simple')
  })
})

describe('mergeImageConfig', () => {
  it('fills gaps from defaults', () => {
    const m = mergeImageConfig({ baseURL: 'http://rig:8188', steps: 8 })
    expect(m.baseURL).toBe('http://rig:8188')
    expect(m.steps).toBe(8)
    expect(m.width).toBe(1024) // from default
  })
  it('returns a full default config for null/undefined', () => {
    expect(mergeImageConfig(null).baseURL).toBeNull()
  })
})

describe('parseImageConfigInput', () => {
  it('accepts a valid partial', () => {
    const p = parseImageConfigInput({ baseURL: 'http://rig:8188', steps: 12 })
    expect(p.baseURL).toBe('http://rig:8188')
    expect(p.steps).toBe(12)
  })
  it('accepts baseURL = null (unconfigured) and empty string -> null', () => {
    expect(parseImageConfigInput({ baseURL: null }).baseURL).toBeNull()
    expect(parseImageConfigInput({ baseURL: '' }).baseURL).toBeNull()
  })
  it('rejects a non-URL baseURL', () => {
    expect(() => parseImageConfigInput({ baseURL: 'not a url' })).toThrow()
  })
})

describe('editStrength', () => {
  it('defaults to 0.55 and is validated in range', async () => {
    const { defaultImageConfig, parseImageConfigInput } = await import('./store')
    expect(defaultImageConfig().editStrength).toBe(0.55)
    expect(parseImageConfigInput({ editStrength: 0.7 }).editStrength).toBe(0.7)
    expect(() => parseImageConfigInput({ editStrength: 2 })).toThrow()
  })
})
