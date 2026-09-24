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
    expect(mapServerMessage(frame as never, false)).toEqual({ messageFrame: frame })
  })

  it('a user-message frame maps to a messageFrame', () => {
    const frame = { type: 'user-message', turnId: 3, message: { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hello world' }] } }
    expect(mapServerMessage(frame as never, false)).toEqual({ messageFrame: frame })
  })
})

describe('mapServerMessage — the post-commit signal', () => {
  it('surfaces a persisted frame as the thread its rows landed in', () => {
    expect(mapServerMessage({ type: 'persisted', conversationId: 'c-1' } as never, false))
      .toEqual({ persisted: 'c-1' })
  })

  it('ignores a persisted frame with no conversation id — it would arm a re-read of nothing', () => {
    expect(mapServerMessage({ type: 'persisted' } as never, false)).toEqual({})
  })

  it('is distinct from the conversation frame, which only the first turn of a thread sends', () => {
    const fx = mapServerMessage({ type: 'conversation', conversationId: 'c-1', title: 'Hi' } as never, false)
    expect(fx.persisted).toBeUndefined()
    expect(fx.conversation).toEqual({ id: 'c-1', title: 'Hi' })
  })
})

describe('mapServerMessage — /clear', () => {
  it('surfaces a cleared frame with its epoch timestamp', () => {
    expect(mapServerMessage({ type: 'cleared', epochAt: '2026-01-01T00:00:00.000Z' } as never, false))
      .toEqual({ cleared: { epochAt: '2026-01-01T00:00:00.000Z' } })
  })

  it('a null epochAt still surfaces as cleared — the no-op case, not a dropped frame', () => {
    expect(mapServerMessage({ type: 'cleared', epochAt: null } as never, false))
      .toEqual({ cleared: { epochAt: null } })
  })

  it('a missing epochAt field defaults to null the same way', () => {
    expect(mapServerMessage({ type: 'cleared' } as never, false))
      .toEqual({ cleared: { epochAt: null } })
  })
})
