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

describe('mapServerMessage — steered', () => {
  it('surfaces a steered frame with its text', () => {
    expect(mapServerMessage({ type: 'steered', text: 'also check the queue' } as never, false))
      .toEqual({ steered: 'also check the queue' })
  })

  it('ignores a steered frame with no text', () => {
    expect(mapServerMessage({ type: 'steered' } as never, false)).toEqual({})
  })
})

// Belt-and-braces alongside the client's turn-id tracking (app/lib/agent/turn-stream.ts): a
// chunk/user-message/audio-begin frame tagged (server/lib/agent/runtime/stream.ts's
// `withCid`) for a conversation the socket no longer views must be dropped outright,
// regardless of what the turn-id bookkeeping decides.
describe('mapServerMessage — cid guard (belt-and-braces against a stray frame from a thread we switched away from)', () => {
  it('drops a chunk frame whose cid does not match the currently viewed conversationId', () => {
    const frame = { type: 'chunk', turnId: 3, cid: 'thread-A', chunk: { type: 'text-delta', id: 't', delta: 'ghost' } }
    expect(mapServerMessage(frame as never, false, 'thread-B')).toEqual({})
  })

  it('drops a user-message frame with a mismatched cid', () => {
    const frame = { type: 'user-message', turnId: 3, cid: 'thread-A', message: { id: 'u', role: 'user', parts: [{ type: 'text', text: 'ghost' }] } }
    expect(mapServerMessage(frame as never, false, 'thread-B')).toEqual({})
  })

  it('drops an audio-begin frame with a mismatched cid', () => {
    const frame = { type: 'audio-begin', segmentId: 1, sampleRate: 24000, cid: 'thread-A' }
    expect(mapServerMessage(frame as never, false, 'thread-B')).toEqual({})
  })

  it('passes a chunk frame through when the cid MATCHES the currently viewed conversationId', () => {
    const frame = { type: 'chunk', turnId: 3, cid: 'thread-B', chunk: { type: 'text-delta', id: 't', delta: 'hi' } }
    expect(mapServerMessage(frame as never, false, 'thread-B')).toEqual({ messageFrame: frame })
  })

  it('passes a chunk frame through when it carries no cid at all (older/untagged frame shape)', () => {
    const frame = { type: 'chunk', turnId: 3, chunk: { type: 'text-delta', id: 't', delta: 'hi' } }
    expect(mapServerMessage(frame as never, false, 'thread-B')).toEqual({ messageFrame: frame })
  })

  it('passes everything through while viewedConversationId is null (a brand-new thread, nothing to compare against yet)', () => {
    const frame = { type: 'chunk', turnId: 3, cid: 'thread-A', chunk: { type: 'text-delta', id: 't', delta: 'hi' } }
    expect(mapServerMessage(frame as never, false, null)).toEqual({ messageFrame: frame })
  })

  it('never gates a frame type outside the three cid-checked ones, even with a mismatched cid', () => {
    // `state` isn't one of the three gated types — a cid on it (it never actually carries one
    // server-side) must not accidentally start being filtered.
    expect(mapServerMessage({ type: 'state', state: 'idle', cid: 'thread-A' } as never, false, 'thread-B'))
      .toEqual({ state: 'idle' })
  })
})
