import { describe, it, expect } from 'vitest'
import { mapServerMessage } from './messages'

describe('mapServerMessage — audio framing', () => {
  it('surfaces audio-begin with its sample rate', () => {
    const fx = mapServerMessage({ type: 'audio-begin', segmentId: 1, sampleRate: 24000 } as never, false)
    expect(fx.audioBegin).toEqual({ segmentId: 1, sampleRate: 24000, turnId: undefined })
  })
  it('surfaces audio-end', () => {
    const fx = mapServerMessage({ type: 'audio-end', segmentId: 3 } as never, false)
    expect(fx.audioEnd).toBe(3)
  })
  it('audio-begin carries its turnId', () => {
    expect(mapServerMessage({ type: 'audio-begin', segmentId: 1, sampleRate: 24000, turnId: 3 } as never, false).audioBegin)
      .toEqual({ segmentId: 1, sampleRate: 24000, turnId: 3 })
  })
})

describe('mapServerMessage — message frames', () => {
  it('passes chunk frames through as messageFrame', () => {
    const frame = { type: 'chunk', turnId: 3, chunk: { type: 'text-delta', id: 't', delta: 'hi' } }
    expect(mapServerMessage(frame as never, false)).toEqual({ messageFrame: frame, events: [] })
  })

  it('a user-message frame is a messageFrame plus the sttFinal viz event', () => {
    const frame = { type: 'user-message', turnId: 3, message: { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hello world' }] } }
    expect(mapServerMessage(frame as never, false)).toEqual({ messageFrame: frame, events: [{ type: 'sttFinal', chars: 11 }] })
  })
})
