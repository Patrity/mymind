import { describe, it, expect } from 'vitest'
import { StreamHub, type Sink } from '@mymind/core/lib/agent/runtime/stream'

function sink(id: string) {
  const got: (string | Uint8Array)[] = []
  const s: Sink = { id, send: d => got.push(d) }
  return { s, got }
}

describe('StreamHub', () => {
  it('fans JSON frames to every subscriber of the conversation only', () => {
    const h = new StreamHub(); const a = sink('a'); const b = sink('b'); const other = sink('o')
    h.subscribe('c1', a.s); h.subscribe('c1', b.s); h.subscribe('c2', other.s)
    h.beginRun('c1'); h.publish('c1', '{"type":"chunk"}')
    expect(a.got).toEqual(['{"type":"chunk"}']); expect(b.got).toEqual(['{"type":"chunk"}']); expect(other.got).toEqual([])
  })

  it('targeted frames go only to the named sink and are never replayed', () => {
    const h = new StreamHub(); const a = sink('a'); const b = sink('b')
    h.subscribe('c1', a.s); h.subscribe('c1', b.s); h.beginRun('c1')
    h.publish('c1', new Uint8Array([1]), { only: 'a' })
    expect(a.got).toHaveLength(1); expect(b.got).toHaveLength(0)
    h.publish('c1', '{"type":"audio-begin"}', { only: 'a' })
    expect(a.got).toHaveLength(2); expect(b.got).toHaveLength(0)
    const late = sink('late'); h.subscribe('c1', late.s, { replay: true })
    expect(late.got).toHaveLength(0)
  })

  it('a late subscriber with replay gets the running turn so far, in order, then live frames', () => {
    const h = new StreamHub(); h.beginRun('c1')
    h.publish('c1', 'f1'); h.publish('c1', 'f2')
    const late = sink('late'); h.subscribe('c1', late.s, { replay: true })
    h.publish('c1', 'f3')
    expect(late.got).toEqual(['f1', 'f2', 'f3'])
  })

  it('endRun clears the replay buffer', () => {
    const h = new StreamHub(); h.beginRun('c1'); h.publish('c1', 'f1'); h.endRun('c1')
    const late = sink('late'); h.subscribe('c1', late.s, { replay: true })
    expect(late.got).toEqual([])
  })

  it('unsubscribe stops delivery, hasSink tracks attachment, and one throwing sink does not break others', () => {
    const h = new StreamHub(); const bad: Sink = { id: 'bad', send: () => { throw new Error('closed') } }; const ok = sink('ok')
    const off = h.subscribe('c1', ok.s); h.subscribe('c1', bad)
    h.beginRun('c1'); h.publish('c1', 'x')
    expect(ok.got).toEqual(['x'])
    expect(h.hasSink('ok')).toBe(true); off(); expect(h.hasSink('ok')).toBe(false)
    h.publish('c1', 'y'); expect(ok.got).toEqual(['x'])
  })
})
