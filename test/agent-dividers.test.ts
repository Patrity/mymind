import { describe, it, expect } from 'vitest'
import { epochDividers, type DividerMessage } from '../app/lib/agent/dividers'

const msg = (id: string, createdAt?: string): DividerMessage =>
  createdAt ? { id, metadata: { createdAt } } : { id }

// A thread cleared at 12:00, with two messages on either side of it.
const BEFORE = [msg('a', '2026-09-25T11:58:00Z'), msg('b', '2026-09-25T11:59:00Z')]
const AFTER = [msg('c', '2026-09-25T12:01:00Z'), msg('d', '2026-09-25T12:02:00Z')]
const EPOCH = '2026-09-25T12:00:00Z'

describe('epochDividers', () => {
  it('draws nothing for a conversation that was never cleared', () => {
    expect(epochDividers(null, [...BEFORE, ...AFTER])).toEqual([])
    expect(epochDividers(undefined, BEFORE)).toEqual([])
  })

  it('draws after the last message that predates the epoch', () => {
    expect(epochDividers(EPOCH, [...BEFORE, ...AFTER])).toEqual([
      { afterMessageId: 'b', epochAt: EPOCH }
    ])
  })

  it('draws above the whole transcript when every message postdates the epoch', () => {
    // afterMessageId null is the "at the very top" signal, not "nowhere" — a thread cleared
    // before anything visible was said still needs to say so.
    expect(epochDividers(EPOCH, AFTER)).toEqual([{ afterMessageId: null, epochAt: EPOCH }])
  })

  it('draws after the last message when every message predates the epoch', () => {
    // The live `/clear` case: the server reset its history, the transcript is untouched, so
    // the boundary is below everything currently on screen.
    expect(epochDividers(EPOCH, BEFORE)).toEqual([{ afterMessageId: 'b', epochAt: EPOCH }])
  })

  it('puts a still-streaming message (no createdAt) BELOW the line', () => {
    // Anything mid-stream necessarily began after a clear that already committed. Treating a
    // missing timestamp as "old" would strand the divider under the live reply.
    expect(epochDividers(EPOCH, [...BEFORE, msg('live')])).toEqual([
      { afterMessageId: 'b', epochAt: EPOCH }
    ])
  })

  it('stops at the first message at or after the epoch, not the last one before it', () => {
    // Guards the walk against an out-of-order row dragging the boundary forward: 'c' is after
    // the epoch, so 'e' must not be picked up even though it predates it.
    const outOfOrder = [...BEFORE, msg('c', '2026-09-25T12:01:00Z'), msg('e', '2026-09-25T11:59:30Z')]
    expect(epochDividers(EPOCH, outOfOrder)[0]!.afterMessageId).toBe('b')
  })

  it('draws nothing rather than guessing when the epoch is unparseable', () => {
    expect(epochDividers('not-a-date', BEFORE)).toEqual([])
  })

  it('stops at a malformed message timestamp instead of sliding past it', () => {
    const bad = [msg('a', '2026-09-25T11:58:00Z'), msg('x', 'garbage'), msg('b', '2026-09-25T11:59:00Z')]
    expect(epochDividers(EPOCH, bad)[0]!.afterMessageId).toBe('a')
  })

  it('returns exactly one divider — the column holds one epoch', () => {
    expect(epochDividers(EPOCH, [...BEFORE, ...AFTER])).toHaveLength(1)
  })
})
