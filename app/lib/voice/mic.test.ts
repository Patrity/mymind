import { describe, it, expect } from 'vitest'
import { BASE_AUDIO, micConstraints, isStaleDeviceError } from './mic'

describe('micConstraints', () => {
  it('asks for the exact device when one is chosen, so a stale pick fails loudly', () => {
    expect(micConstraints('abc123')).toEqual({ ...BASE_AUDIO, deviceId: { exact: 'abc123' } })
  })

  it('omits deviceId entirely when none is chosen — "" means let the OS decide', () => {
    expect(micConstraints('')).toEqual({ ...BASE_AUDIO })
    expect('deviceId' in micConstraints('')).toBe(false)
  })
})

describe('isStaleDeviceError', () => {
  it('recognises the unplugged-device error', () => {
    expect(isStaleDeviceError({ name: 'OverconstrainedError' })).toBe(true)
  })

  it('does not swallow a permission denial — that must surface, not silently fall back', () => {
    expect(isStaleDeviceError({ name: 'NotAllowedError' })).toBe(false)
    expect(isStaleDeviceError(new Error('boom'))).toBe(false)
    expect(isStaleDeviceError(null)).toBe(false)
  })
})
