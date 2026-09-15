import { describe, it, expect } from 'vitest'
import { validateBreezeRequest, type BreezeRequest } from './breeze'

const base: BreezeRequest = {
  text: 'Hello.', instruction: null, cfgScale: 1.0, seed: 11,
  temperature: 0.9, topP: 1.0, topK: 50, refAudio: null, refText: null
}

describe('validateBreezeRequest', () => {
  it('passes a plain request', () => {
    expect(validateBreezeRequest(base)).toBeNull()
  })

  // The rig answers this with 500 + an opaque "Internal Server Error" body — there is
  // nothing in the response to branch on, so it MUST be caught before dispatch.
  it('rejects cfg_scale > 1 without an instruction', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 4 }))
      .toMatch(/cfg_scale/)
  })

  it('accepts cfg_scale > 1 when an instruction is present', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 4, instruction: 'A calm man.' })).toBeNull()
  })

  it('treats a whitespace-only instruction as absent for the cfg_scale rule', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 4, instruction: '  ' }))
      .toMatch(/cfg_scale/)
  })

  it('rejects ref_audio without ref_text', () => {
    expect(validateBreezeRequest({ ...base, refAudio: { bytes: new Uint8Array([1]), filename: 'r.wav' } }))
      .toMatch(/ref_text/)
  })

  it('rejects empty text', () => {
    expect(validateBreezeRequest({ ...base, text: '   ' })).toMatch(/text/)
  })

  it('rejects cfg_scale <= 0', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 0 })).toMatch(/cfg_scale/)
  })
})
