import { describe, it, expect } from 'vitest'
import { mapServerMessage } from '../app/lib/voice/messages'

describe('mapServerMessage', () => {
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
    const fx = mapServerMessage({ type: 'nonsense', text: 'x' }, false)
    expect(fx.state).toBeUndefined()
    expect(fx.messageFrame).toBeUndefined()
    expect(fx.events).toEqual([])
  })

  it('typing state message → state:typing, no events', () => {
    const fx = mapServerMessage({ type: 'state', state: 'typing' }, false)
    expect(fx.state).toBe('typing')
    expect(fx.events).toEqual([])
  })

  it('passes chunk frames through as messageFrame', () => {
    const frame = { type: 'chunk', turnId: 3, chunk: { type: 'text-delta', id: 't', delta: 'hi' } }
    expect(mapServerMessage(frame as never, false)).toEqual({ messageFrame: frame, events: [] })
  })

  it('a user-message frame is a messageFrame plus the sttFinal viz event', () => {
    const frame = { type: 'user-message', turnId: 3, message: { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hello world' }] } }
    expect(mapServerMessage(frame as never, false)).toEqual({ messageFrame: frame, events: [{ type: 'sttFinal', chars: 11 }] })
  })

  it('audio-begin carries its turnId', () => {
    expect(mapServerMessage({ type: 'audio-begin', segmentId: 1, sampleRate: 24000, turnId: 3 } as never, false).audioBegin)
      .toEqual({ segmentId: 1, sampleRate: 24000, turnId: 3 })
  })
})

describe('mapServerMessage conversation frame', () => {
  it('maps the lazily-created thread id + derived title', () => {
    const fx = mapServerMessage({ type: 'conversation', conversationId: 'c1', title: 'Where is my cat' }, false)
    expect(fx.conversation).toEqual({ id: 'c1', title: 'Where is my cat' })
    expect(fx.messageFrame).toBeUndefined()
    expect(fx.events).toEqual([])
  })
  it('a null/absent title maps to null, not undefined', () => {
    expect(mapServerMessage({ type: 'conversation', conversationId: 'c1' }, false).conversation).toEqual({ id: 'c1', title: null })
    expect(mapServerMessage({ type: 'conversation', conversationId: 'c1', title: null }, false).conversation).toEqual({ id: 'c1', title: null })
  })
  it('a conversation frame without an id is inert', () => {
    expect(mapServerMessage({ type: 'conversation', title: 'x' }, false).conversation).toBeUndefined()
  })
})

describe('mapServerMessage approval frames', () => {
  it('maps an approval request', () => {
    const fx = mapServerMessage({ type: 'approval', requestId: 'r1', tool: 'exec', command: 'git status', proposedPattern: 'git *' }, false)
    expect(fx.approval).toEqual({ requestId: 'r1', tool: 'exec', command: 'git status', proposedPattern: 'git *' })
  })
  it('maps an approval-resolved (timeout) frame', () => {
    expect(mapServerMessage({ type: 'approval-resolved', requestId: 'r1' }, false).approvalResolved).toBe('r1')
  })
})
