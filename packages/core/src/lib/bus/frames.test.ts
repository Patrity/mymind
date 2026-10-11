// Cycle 81 Task 1 — pure parts of the bus: delta merging, notify pointer parsing, NOTIFY size cap.
import { describe, it, expect } from 'vitest'
import { tryMerge, parseRunEventNotify, type HubFrame } from './events'
import { encodeLiveWire, MAX_NOTIFY_BYTES } from './live'

const d = (id: string, delta: string, type: 'text-delta' | 'reasoning-delta' = 'text-delta', turnId = 1): HubFrame =>
  ({ type: 'chunk', turnId, chunk: { type, id, delta } } as HubFrame)

describe('tryMerge', () => {
  it('merges same-part deltas with the same targeting', () => {
    const last = { frame: d('a', 'he'), only: null }
    expect(tryMerge(last, { frame: d('a', 'llo'), only: null })).toBe(true)
    expect((last.frame as { chunk: { delta: string } }).chunk.delta).toBe('hello')
  })
  it('refuses across parts, kinds, turns, targeting and non-delta frames', () => {
    const base = () => ({ frame: d('a', 'x'), only: null as string | null })
    expect(tryMerge(base(), { frame: d('b', 'y'), only: null })).toBe(false)
    expect(tryMerge(base(), { frame: d('a', 'y', 'reasoning-delta'), only: null })).toBe(false)
    expect(tryMerge(base(), { frame: d('a', 'y', 'text-delta', 2), only: null })).toBe(false)
    expect(tryMerge(base(), { frame: d('a', 'y'), only: 'sink' })).toBe(false)
    expect(tryMerge(base(), { frame: { type: 'state', state: 'idle' }, only: null })).toBe(false)
    expect(tryMerge({ frame: { type: 'state', state: 'idle' }, only: null }, { frame: d('a', 'y'), only: null })).toBe(false)
    expect(tryMerge(undefined, { frame: d('a', 'y'), only: null })).toBe(false)
  })
})

describe('parseRunEventNotify', () => {
  it('parses <conversation>:<id>', () => {
    expect(parseRunEventNotify('0b7c-uuid:42')).toEqual({ conversationId: '0b7c-uuid', id: 42 })
    expect(parseRunEventNotify('nope')).toBeNull()
    expect(parseRunEventNotify('c:x')).toBeNull()
  })
})

describe('encodeLiveWire', () => {
  it('passes small events, truncates an oversized activity summary, drops what still does not fit', () => {
    const small = encodeLiveWire({ o: 'me', k: 'change', e: { v: 1, resource: 'task', action: 'updated', id: 't1', at: 1 } })
    expect(JSON.parse(small!)).toMatchObject({ k: 'change', e: { id: 't1' } })
    const big = encodeLiveWire({ o: 'me', k: 'activity', e: { type: 'tool', name: 'x', summary: 'y'.repeat(20_000) } })
    expect(big).not.toBeNull()
    expect(Buffer.byteLength(big!)).toBeLessThanOrEqual(MAX_NOTIFY_BYTES)
    expect(encodeLiveWire({ o: 'me', k: 'change', e: { v: 1, resource: 'task', action: 'updated', id: 'z'.repeat(9_000), at: 1 } })).toBeNull()
  })
})
