import { describe, it, expect } from 'vitest'
import { presetMode } from './voice-presets'

describe('presetMode', () => {
  it('is plain with neither instruction nor reference', () => {
    expect(presetMode({ instruction: null, refStorageKey: null })).toBe('plain')
  })
  it('is design with an instruction and no reference', () => {
    expect(presetMode({ instruction: 'A calm man.', refStorageKey: null })).toBe('design')
  })
  it('is clone with a reference and no instruction', () => {
    expect(presetMode({ instruction: null, refStorageKey: 'abc' })).toBe('clone')
  })
  it('is direction with both', () => {
    expect(presetMode({ instruction: 'Warmly.', refStorageKey: 'abc' })).toBe('direction')
  })
  it('treats a whitespace-only instruction as absent', () => {
    expect(presetMode({ instruction: '   ', refStorageKey: null })).toBe('plain')
  })
})
