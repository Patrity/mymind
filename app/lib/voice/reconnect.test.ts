import { describe, it, expect, vi } from 'vitest'
import { framesOnOpen, reconnectDelay, sessionExpired, RECONNECT_MAX_MS, RECONNECTING_AFTER } from './reconnect'

describe('framesOnOpen', () => {
  it('re-sends load + attach for the thread on screen (a reconnect restores the view)', () => {
    const shouldAttach = vi.fn(() => true)
    const frames = framesOnOpen({ presetId: 'p1', modelDefId: 'm1', conversationId: 'c1', shouldAttach })
    expect(frames).toEqual([
      { type: 'preset', presetId: 'p1' },
      { type: 'model', modelDefId: 'm1' },
      { type: 'load', conversationId: 'c1' },
      { type: 'attach' }
    ])
    expect(shouldAttach).toHaveBeenCalledWith('c1')
  })

  it('sends neither load nor attach when no thread is viewed', () => {
    expect(framesOnOpen({ presetId: '', modelDefId: null, conversationId: null, shouldAttach: () => true }))
      .toEqual([{ type: 'preset', presetId: '' }])
  })

  it('loads but does not re-attach when the attach is already recorded for this thread', () => {
    expect(framesOnOpen({ presetId: '', modelDefId: null, conversationId: 'c1', shouldAttach: () => false }))
      .toEqual([{ type: 'preset', presetId: '' }, { type: 'load', conversationId: 'c1' }])
  })

  it('an auto-reconnect attaches with the last seq rendered per run (cycle 81)', () => {
    expect(framesOnOpen({ presetId: '', modelDefId: null, conversationId: 'c1', shouldAttach: () => true, resume: { conversationId: 'c1', after: { r1: 7 } } }))
      .toEqual([{ type: 'preset', presetId: '' }, { type: 'load', conversationId: 'c1' }, { type: 'attach', after: { r1: 7 } }])
  })

  it('a new thread whose id has not landed resumes the thread its turn named', () => {
    expect(framesOnOpen({ presetId: '', modelDefId: null, conversationId: null, shouldAttach: () => true, resume: { conversationId: 'c9', after: { r1: 2 } } }))
      .toEqual([{ type: 'preset', presetId: '' }, { type: 'load', conversationId: 'c9' }, { type: 'attach', after: { r1: 2 } }])
  })
})

describe('reconnectDelay (jittered backoff)', () => {
  it('doubles from 500ms, capped at 8s, and jitters into 50–100% of that', () => {
    expect(reconnectDelay(0, 0.999999)).toBe(500)
    expect(reconnectDelay(0, 0)).toBe(250)
    expect(reconnectDelay(1, 0.999999)).toBe(1000)
    expect(reconnectDelay(3, 0.5)).toBe(3000)
    expect(reconnectDelay(10, 0.999999)).toBe(RECONNECT_MAX_MS)
    expect(reconnectDelay(10, 0)).toBe(RECONNECT_MAX_MS / 2)
  })
  it('two tabs drawing different randoms wait different times (no thundering herd)', () => {
    expect(reconnectDelay(4, 0.1)).not.toBe(reconnectDelay(4, 0.9))
  })
  it('shows "Reconnecting…" only after a few attempts', () => {
    expect(RECONNECTING_AFTER).toBeGreaterThanOrEqual(2)
  })
})

describe('sessionExpired', () => {
  it('expired only when the auth endpoint answered with no session', () => {
    expect(sessionExpired({ data: null, error: null })).toBe(true)
    expect(sessionExpired({ data: { session: null } })).toBe(true)
    expect(sessionExpired({ data: { session: { id: 's' } }, error: null })).toBe(false)
  })
  it('a failed auth request (server still down) is not expired', () => {
    expect(sessionExpired({ data: null, error: { status: 502 } })).toBe(false)
    expect(sessionExpired(null)).toBe(false)
  })
})
