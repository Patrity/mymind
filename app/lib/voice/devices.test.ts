import { describe, it, expect } from 'vitest'
import { DEFAULT_MIC, buildMicOptions, micIdToSelectValue, selectValueToMicId, isMicIdAvailable } from './devices'

describe('buildMicOptions', () => {
  it('always leads with System default', () => {
    const opts = buildMicOptions([])
    expect(opts).toEqual([{ label: 'System default', value: DEFAULT_MIC }])
  })

  it('uses the real label when present', () => {
    const opts = buildMicOptions([{ deviceId: 'abc', label: 'USB Headset' }])
    expect(opts).toEqual([
      { label: 'System default', value: DEFAULT_MIC },
      { label: 'USB Headset', value: 'abc' }
    ])
  })

  it('falls back to a positional name when labels are empty (no mic permission granted yet)', () => {
    const opts = buildMicOptions([
      { deviceId: 'abc', label: '' },
      { deviceId: 'def', label: '' }
    ])
    expect(opts).toEqual([
      { label: 'System default', value: DEFAULT_MIC },
      { label: 'Microphone 1', value: 'abc' },
      { label: 'Microphone 2', value: 'def' }
    ])
  })

  it('mixes real and fallback labels independently, keyed by position not identity', () => {
    const opts = buildMicOptions([
      { deviceId: 'abc', label: '' },
      { deviceId: 'def', label: 'Built-in Microphone' }
    ])
    expect(opts).toEqual([
      { label: 'System default', value: DEFAULT_MIC },
      { label: 'Microphone 1', value: 'abc' },
      { label: 'Built-in Microphone', value: 'def' }
    ])
  })
})

describe('mic id <-> select value sentinel round-trip', () => {
  it('system default ("") maps to the sentinel and back', () => {
    expect(micIdToSelectValue('')).toBe(DEFAULT_MIC)
    expect(selectValueToMicId(DEFAULT_MIC)).toBe('')
  })

  it('a real device id passes through untouched in both directions', () => {
    expect(micIdToSelectValue('abc-123')).toBe('abc-123')
    expect(selectValueToMicId('abc-123')).toBe('abc-123')
  })

  it('round-trips every value back to its origin', () => {
    for (const id of ['', 'abc-123', 'def-456']) {
      expect(selectValueToMicId(micIdToSelectValue(id))).toBe(id)
    }
  })
})

describe('isMicIdAvailable', () => {
  it('system default is always available', () => {
    expect(isMicIdAvailable('', [])).toBe(true)
  })

  it('true when the stored id is still in the list', () => {
    expect(isMicIdAvailable('abc', [{ deviceId: 'abc', label: 'X' }])).toBe(true)
  })

  it('false when the stored id has vanished (device unplugged since it was chosen)', () => {
    expect(isMicIdAvailable('abc', [{ deviceId: 'def', label: 'X' }])).toBe(false)
    expect(isMicIdAvailable('abc', [])).toBe(false)
  })
})
