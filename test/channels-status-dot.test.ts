// Cycle 75, Task 11: the Channels nav dot colour from GET /api/channels/status's iMessage health.
import { describe, it, expect } from 'vitest'
import { channelsDotColor } from '../app/lib/channels/status-dot'

describe('channelsDotColor', () => {
  it('hidden while iMessage is disabled (or status not loaded yet)', () => {
    expect(channelsDotColor({ enabled: false, ok: false, privateApi: null })).toBeNull()
    expect(channelsDotColor({ enabled: false, ok: true, privateApi: true })).toBeNull()
    expect(channelsDotColor(undefined)).toBeNull()
  })
  it('green when ok with the Private API on', () => {
    expect(channelsDotColor({ enabled: true, ok: true, privateApi: true, checkedAt: 1 })).toBe('success')
  })
  it('amber when ok with the Private API off', () => {
    expect(channelsDotColor({ enabled: true, ok: true, privateApi: false, checkedAt: 1 })).toBe('warning')
  })
  it('red when the last check failed, whatever the Private API said', () => {
    expect(channelsDotColor({ enabled: true, ok: false, privateApi: null, checkedAt: 1 })).toBe('error')
    expect(channelsDotColor({ enabled: true, ok: false, privateApi: true, checkedAt: 1 })).toBe('error')
  })
  it('neutral while enabled but not checked yet (M6) — never red before the first check', () => {
    expect(channelsDotColor({ enabled: true, ok: false, privateApi: null, checkedAt: null })).toBe('neutral')
  })
})
