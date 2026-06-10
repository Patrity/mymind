import { describe, it, expect } from 'vitest'
import { mapServerMessage } from '../app/lib/voice/messages'

describe('mapServerMessage', () => {
  it('user transcript → delta + sttFinal event with char count', () => {
    const fx = mapServerMessage({ type: 'transcript', role: 'user', text: 'hello world' }, false)
    expect(fx.delta).toEqual({ role: 'user', text: 'hello world' })
    expect(fx.events).toEqual([{ type: 'sttFinal', chars: 11 }])
  })

  it('assistant transcript → delta, no events', () => {
    const fx = mapServerMessage({ type: 'transcript', role: 'assistant', text: 'hi' }, false)
    expect(fx.delta).toEqual({ role: 'assistant', text: 'hi' })
    expect(fx.events).toEqual([])
  })

  it('maps state messages, including tool', () => {
    expect(mapServerMessage({ type: 'state', state: 'speaking' }, false).state).toBe('speaking')
    expect(mapServerMessage({ type: 'state', state: 'thinking' }, false).state).toBe('thinking')
    expect(mapServerMessage({ type: 'state', state: 'tool' }, false).state).toBe('tool')
  })

  it('ignores premature idle while audio is still playing', () => {
    expect(mapServerMessage({ type: 'state', state: 'idle' }, true).state).toBeUndefined()
    expect(mapServerMessage({ type: 'state', state: 'idle' }, false).state).toBe('idle')
  })

  it('server error message → error text + error viz event + idle state', () => {
    const fx = mapServerMessage({ type: 'error', message: 'STT failed: 415' }, false)
    expect(fx.error).toBe('STT failed: 415')
    expect(fx.events).toEqual([{ type: 'error' }])
  })

  it('unknown messages are inert', () => {
    const fx = mapServerMessage({ type: 'tool', text: 'x' }, false)
    expect(fx.state).toBeUndefined()
    expect(fx.delta).toBeUndefined()
    expect(fx.events).toEqual([])
  })
})
