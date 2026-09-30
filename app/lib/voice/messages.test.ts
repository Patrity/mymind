import { describe, it, expect } from 'vitest'
import { mapServerMessage, queuedEchoIndex, QUEUED_ID_PREFIX } from './messages'

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

  // Fix round 1: steered is conversation-scoped (ws.ts tags it with its thread) — a steer bubble
  // must not paint into a thread the socket has since navigated to.
  it('surfaces a steered frame whose cid is the viewed thread', () => {
    expect(mapServerMessage({ type: 'steered', text: 'also', cid: 'thread-B' } as never, false, 'thread-B'))
      .toEqual({ steered: 'also' })
  })

  it('drops a steered frame whose cid is not the viewed thread', () => {
    expect(mapServerMessage({ type: 'steered', text: 'also', cid: 'thread-A' } as never, false, 'thread-B')).toEqual({})
  })

  it('ignores a steered frame with no text', () => {
    expect(mapServerMessage({ type: 'steered' } as never, false)).toEqual({})
  })
})

// Cycle 74: a user message queued behind a running headless (wake) run. Conversation-scoped —
// it carries `cid` and a straggler from a thread we left must not paint a bubble here.
describe('mapServerMessage — queued', () => {
  it('surfaces a queued frame for the viewed thread with its text', () => {
    expect(mapServerMessage({ type: 'queued', text: 'hi', cid: 'thread-B' } as never, false, 'thread-B'))
      .toEqual({ queued: 'hi' })
  })

  it('drops a queued frame whose cid is not the viewed thread', () => {
    expect(mapServerMessage({ type: 'queued', text: 'hi', cid: 'thread-A' } as never, false, 'thread-B')).toEqual({})
  })

  it('ignores a queued frame with no text', () => {
    expect(mapServerMessage({ type: 'queued', cid: 'thread-B' } as never, false, 'thread-B')).toStrictEqual({})
  })
})

describe('queuedEchoIndex — the queued run\'s own user-message replaces its optimistic bubble', () => {
  const bubble = (id: string, text: string, role = 'user') => ({ id, role, parts: [{ type: 'text', text }] })
  it('finds the optimistic queued bubble whose text matches the arriving user message', () => {
    const list = [bubble('m1', 'hi'), bubble(`${QUEUED_ID_PREFIX}1`, 'other'), bubble(`${QUEUED_ID_PREFIX}2`, 'hi')]
    expect(queuedEchoIndex(list, bubble('u9', 'hi'))).toBe(2)
  })

  it('never matches a real row or a steer bubble with the same text', () => {
    const list = [bubble('m1', 'hi'), bubble('steer-1', 'hi')]
    expect(queuedEchoIndex(list, bubble('u9', 'hi'))).toBe(-1)
  })

  it('only a USER message can replace the bubble', () => {
    expect(queuedEchoIndex([bubble(`${QUEUED_ID_PREFIX}1`, 'hi')], bubble('a9', 'hi', 'assistant'))).toBe(-1)
  })

  it('does not match on different text', () => {
    expect(queuedEchoIndex([bubble(`${QUEUED_ID_PREFIX}1`, 'hi')], bubble('u9', 'bye'))).toBe(-1)
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

  it('drops a state frame with a mismatched cid (an A straggler must not flip busy on B)', () => {
    expect(mapServerMessage({ type: 'state', state: 'thinking', cid: 'thread-A' } as never, false, 'thread-B')).toEqual({})
    expect(mapServerMessage({ type: 'state', state: 'idle', cid: 'thread-A' } as never, false, 'thread-B')).toEqual({})
  })

  it('drops an error frame with a mismatched cid (no stray alert on B for A\'s failure)', () => {
    expect(mapServerMessage({ type: 'error', message: 'A blew up', cid: 'thread-A' } as never, false, 'thread-B')).toEqual({})
  })

  it('passes state/error frames whose cid matches, and untagged (per-socket) ones', () => {
    expect(mapServerMessage({ type: 'state', state: 'thinking', cid: 'thread-B' } as never, false, 'thread-B')).toEqual({ state: 'thinking' })
    expect(mapServerMessage({ type: 'error', message: 'B failed', cid: 'thread-B' } as never, false, 'thread-B')).toEqual({ error: 'B failed' })
    // ws.ts's submit-failure pair goes straight to the peer, untagged.
    expect(mapServerMessage({ type: 'state', state: 'idle' } as never, false, 'thread-B')).toEqual({ state: 'idle' })
    expect(mapServerMessage({ type: 'error', message: 'could not start' } as never, false, 'thread-B')).toEqual({ error: 'could not start' })
  })

  it('drops a conversation frame for a thread other than the viewed one', () => {
    expect(mapServerMessage({ type: 'conversation', conversationId: 'thread-A', title: 't', cid: 'thread-A' } as never, false, 'thread-B'))
      .toEqual({})
    expect(mapServerMessage({ type: 'conversation', conversationId: 'thread-B', title: 't', cid: 'thread-B' } as never, false, 'thread-B'))
      .toEqual({ conversation: { id: 'thread-B', title: 't' } })
  })

  it('never gates persisted/approval, even with a mismatched cid', () => {
    expect(mapServerMessage({ type: 'persisted', conversationId: 'thread-A', cid: 'thread-A' } as never, false, 'thread-B'))
      .toEqual({ persisted: 'thread-A' })
    expect(mapServerMessage({ type: 'approval', requestId: 'r', command: 'ls', cid: 'thread-A' } as never, false, 'thread-B'))
      .toEqual({ approval: { requestId: 'r', tool: 'exec', command: 'ls', proposedPattern: '', allowlistable: false } })
  })

  describe('viewing nothing (after `new`) — the left view', () => {
    const delta = { type: 'chunk', turnId: 45, cid: 'thread-A', chunk: { type: 'text-delta', id: 't', delta: 'ghost' } }
    const leftA = { ids: new Set(['thread-A']), submitted: true }
    const conv = (id: string) => ({ type: 'conversation', conversationId: id, title: 't', cid: id })

    it('drops every gated frame type tagged with a thread `new` left, even after a submit', () => {
      expect(mapServerMessage(delta as never, false, null, leftA)).toEqual({})
      expect(mapServerMessage({ type: 'user-message', turnId: 46, cid: 'thread-A', message: { id: 'u', role: 'user', parts: [] } } as never, false, null, leftA)).toEqual({})
      expect(mapServerMessage({ type: 'audio-begin', segmentId: 0, sampleRate: 24000, turnId: 46, cid: 'thread-A' } as never, false, null, leftA)).toEqual({})
      expect(mapServerMessage({ type: 'state', state: 'thinking', cid: 'thread-A' } as never, false, null, leftA)).toEqual({})
      expect(mapServerMessage({ type: 'error', message: 'A failed', cid: 'thread-A' } as never, false, null, leftA)).toEqual({})
      // A's first turn persisting in the gap before the server processed `new`.
      expect(mapServerMessage(conv('thread-A') as never, false, null, leftA)).toEqual({})
    })

    it('after the submit, passes the NEW thread\'s own frames and its conversation frame', () => {
      const own = { ...delta, turnId: 50, cid: 'thread-N' }
      expect(mapServerMessage(own as never, false, null, leftA)).toEqual({ messageFrame: own })
      expect(mapServerMessage({ type: 'state', state: 'thinking', cid: 'thread-N' } as never, false, null, leftA)).toEqual({ state: 'thinking' })
      expect(mapServerMessage(conv('thread-N') as never, false, null, leftA)).toEqual({ conversation: { id: 'thread-N', title: 't' } })
    })

    it('before any submit, drops every tagged scoped frame — even from a thread whose id was never learned', () => {
      const none = { ids: new Set<string>(), submitted: false }
      expect(mapServerMessage(delta as never, false, null, none)).toEqual({})
      expect(mapServerMessage(conv('thread-A') as never, false, null, none)).toEqual({})
      // Untagged per-socket frames still apply.
      expect(mapServerMessage({ type: 'state', state: 'idle' } as never, false, null, none)).toEqual({ state: 'idle' })
    })

    it('passes everything with the default (no left-thread tracking)', () => {
      expect(mapServerMessage(delta as never, false, null)).toEqual({ messageFrame: delta })
    })

    it('ignores the left view once a thread is viewed (the plain mismatch check owns it)', () => {
      const own = { ...delta, cid: 'thread-A' }
      // Viewing A again (resumed back to it): A's frames must render even if A is still "left".
      expect(mapServerMessage(own as never, false, 'thread-A', { ids: new Set(['thread-A']), submitted: false })).toEqual({ messageFrame: own })
    })
  })

  // The reviewer's exact regression, retold at THIS layer (round 2 → round 3): resume()
  // switches from thread A to thread B (discardTurn() + resetTurns(), same synchronous
  // tick). A straggler chunk for A's still-running turn — already in flight over the wire
  // before the server processed `load` and unsubscribed this socket — was tagged by the
  // server with A's conversationId (server/lib/agent/runtime/stream.ts's `withCid`) before
  // it was ever queued for delivery. By the time it arrives, this socket is viewing B — the
  // mismatch drops it here, independent of whatever app/lib/agent/turn-stream.ts's own
  // (now-revocable) `discarded` bookkeeping decides on its own. This is the layer that
  // actually owns cross-thread ghost prevention as of round 3 — see turn-stream.test.ts's
  // sibling test for what changed there (a merely-discarded turn is no longer permanently
  // blocked, so A→B→A can replay again).
  it('a straggler for the OLD thread\'s still-running turn, tagged with the OLD conversationId, is dropped after switching to a new thread', () => {
    const straggler = { type: 'chunk', turnId: 45, cid: 'thread-A', chunk: { type: 'text-delta', id: 'old-a-t', delta: 'GHOST STRAGGLER CONTENT' } }
    // viewedConversationId is now 'thread-B' — resume() already committed the switch by the
    // time this straggler, sent before the server processed the switch, finally arrives.
    expect(mapServerMessage(straggler as never, false, 'thread-B')).toEqual({})
  })
})
