// server/lib/agent/runtime/stream.test.ts
//
// withCid: belt-and-braces alongside the client's turn-id tracking (app/lib/agent/
// turn-stream.ts) — every chunk/user-message/audio-begin frame is tagged with the
// conversationId a subscription is FOR, so the client can independently drop a frame for a
// thread it no longer views (app/lib/voice/messages.ts's mapServerMessage), regardless of
// whatever a turn-id bookkeeping edge case might let through.
import { describe, it, expect } from 'vitest'
import { StreamHub, withCid, type Sink } from './stream'

function fakeSink(id = 'sink-1'): Sink & { received: (string | Uint8Array)[] } {
  const received: (string | Uint8Array)[] = []
  return { id, received, send: (d) => { received.push(d) } }
}

describe('withCid', () => {
  it('injects the conversationId right after the leading brace of a JSON string frame', () => {
    const sink = fakeSink()
    const tagged = withCid('conv-1', sink)
    tagged.send(JSON.stringify({ type: 'chunk', turnId: 5, chunk: { type: 'text-delta' } }))
    expect(sink.received).toHaveLength(1)
    expect(JSON.parse(sink.received[0] as string)).toMatchObject({ cid: 'conv-1', type: 'chunk', turnId: 5 })
  })

  it('leaves a binary (non-string) frame completely untouched', () => {
    const sink = fakeSink()
    const tagged = withCid('conv-1', sink)
    const bytes = new Uint8Array([1, 2, 3])
    tagged.send(bytes)
    expect(sink.received).toEqual([bytes])
  })

  it('keeps the WRAPPED sink\'s id verbatim', () => {
    const sink = fakeSink('peer-42')
    expect(withCid('conv-1', sink).id).toBe('peer-42')
  })

  it('one physical sink subscribing under two different conversationIds tags each with its OWN id', () => {
    const sink = fakeSink()
    const forX = withCid('X', sink)
    const forY = withCid('Y', sink)
    forX.send(JSON.stringify({ type: 'chunk', turnId: 1 }))
    forY.send(JSON.stringify({ type: 'chunk', turnId: 2 }))
    expect(JSON.parse(sink.received[0] as string).cid).toBe('X')
    expect(JSON.parse(sink.received[1] as string).cid).toBe('Y')
  })
})

describe('StreamHub — frames carry cid end-to-end', () => {
  it('a published chunk reaches a subscriber tagged with the conversationId it was published for', () => {
    const hub = new StreamHub()
    const sink = fakeSink()
    hub.beginRun('conv-A')
    hub.subscribe('conv-A', withCid('conv-A', sink))
    hub.publish('conv-A', JSON.stringify({ type: 'chunk', turnId: 1, chunk: { type: 'text-delta' } }))
    expect(sink.received).toHaveLength(1)
    expect(JSON.parse(sink.received[0] as string).cid).toBe('conv-A')
  })

  it('a REPLAYED frame (a late joiner attaching mid-run) is also tagged', () => {
    const hub = new StreamHub()
    hub.beginRun('conv-B')
    hub.publish('conv-B', JSON.stringify({ type: 'chunk', turnId: 1, chunk: { type: 'text-delta' } }))
    const sink = fakeSink()
    hub.subscribe('conv-B', withCid('conv-B', sink), { replay: true })
    expect(sink.received).toHaveLength(1)
    expect(JSON.parse(sink.received[0] as string).cid).toBe('conv-B')
  })

  it('hasSink still counts by the wrapped sink id — a fresh wrapper for a different conversationId is still the same peer', () => {
    const hub = new StreamHub()
    const sink = fakeSink()
    const unsubX = hub.subscribe('conv-X', withCid('conv-X', sink))
    expect(hub.hasSink(sink.id)).toBe(true)
    unsubX()
    expect(hub.hasSink(sink.id)).toBe(false)
    hub.subscribe('conv-Y', withCid('conv-Y', sink))
    expect(hub.hasSink(sink.id)).toBe(true)
  })
})
