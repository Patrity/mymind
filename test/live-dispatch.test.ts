import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dispatchLiveEvent, GRAPH_DEBOUNCE_MS } from '../app/utils/live-dispatch'
import type { LiveEvent } from '../shared/types/live'

function fakeClient() {
  const calls: unknown[][] = []
  return {
    calls,
    invalidateQueries: (arg: unknown) => { calls.push([arg]) }
  }
}

const ev = (over: Partial<LiveEvent> = {}): LiveEvent =>
  ({ v: 1, resource: 'image', action: 'updated', id: 'img-1', at: 0, ...over })

describe('dispatchLiveEvent', () => {
  it('invalidates the detail key and the list key for the resource', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev())
    expect(c.calls).toContainEqual([{ queryKey: ['image', 'img-1'] }])
    expect(c.calls).toContainEqual([{ queryKey: ['image', 'list'] }])
  })

  it('on delete, still invalidates list and detail', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ action: 'deleted' }))
    expect(c.calls).toContainEqual([{ queryKey: ['image', 'list'] }])
    expect(c.calls).toContainEqual([{ queryKey: ['image', 'img-1'] }])
  })

  it('maps a different resource to its own keys', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'memory', id: 'm-9' }))
    expect(c.calls).toContainEqual([{ queryKey: ['memory', 'm-9'] }])
    expect(c.calls).toContainEqual([{ queryKey: ['memory', 'list'] }])
  })

  it('memory events also invalidate the badge count', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'memory', id: 'm-1' }))
    expect(c.calls).toContainEqual([{ queryKey: ['memory', 'count'] }])
  })

  it('review events also invalidate the badge count', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'review', id: 'r-1' }))
    expect(c.calls).toContainEqual([{ queryKey: ['review', 'count'] }])
  })
})

describe('dispatchLiveEvent — activity', () => {
  it('invalidates activity list + count on an activity signal', () => {
    const invalidateQueries = vi.fn()
    dispatchLiveEvent({ invalidateQueries }, { v: 1, resource: 'activity', action: 'created', id: 'batch', at: 0 })
    const keys = invalidateQueries.mock.calls.map(c => JSON.stringify(c[0]!.queryKey))
    expect(keys).toContain(JSON.stringify(['activity', 'list']))
    expect(keys).toContain(JSON.stringify(['activity', 'count']))
  })
})

describe('dispatchLiveEvent — galaxy graph invalidation', () => {
  // The ['graph'] invalidation is trailing-debounced (GRAPH_DEBOUNCE_MS) so a burst of
  // live events collapses into one galaxy refetch — advance fake timers past the
  // window to observe it.
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it.each(['graph', 'memory', 'document', 'image', 'session', 'project'] as const)(
    'invalidates the galaxy query (["graph"]) on a %s event',
    (resource) => {
      const invalidateQueries = vi.fn()
      dispatchLiveEvent({ invalidateQueries }, { v: 1, resource, action: 'updated', id: 'x-1', at: 0 })
      vi.advanceTimersByTime(GRAPH_DEBOUNCE_MS)
      const keys = invalidateQueries.mock.calls.map(c => JSON.stringify(c[0]!.queryKey))
      expect(keys).toContain(JSON.stringify(['graph']))
    }
  )

  it('does not invalidate the galaxy query for unrelated resources', () => {
    const invalidateQueries = vi.fn()
    dispatchLiveEvent({ invalidateQueries }, { v: 1, resource: 'task', action: 'updated', id: 't-1', at: 0 })
    vi.advanceTimersByTime(GRAPH_DEBOUNCE_MS)
    const keys = invalidateQueries.mock.calls.map(c => JSON.stringify(c[0]!.queryKey))
    expect(keys).not.toContain(JSON.stringify(['graph']))
  })

  it('collapses a burst of graph-invalidating events into ONE ["graph"] invalidation', () => {
    const invalidateQueries = vi.fn()
    const client = { invalidateQueries }

    // Simulate an enrich-memories-cron-style burst: several different resources, each
    // individually eligible to invalidate ['graph'], firing within the debounce window.
    dispatchLiveEvent(client, { v: 1, resource: 'memory', action: 'updated', id: 'm-1', at: 0 })
    vi.advanceTimersByTime(GRAPH_DEBOUNCE_MS / 2)
    dispatchLiveEvent(client, { v: 1, resource: 'memory', action: 'updated', id: 'm-2', at: 0 })
    vi.advanceTimersByTime(GRAPH_DEBOUNCE_MS / 2)
    dispatchLiveEvent(client, { v: 1, resource: 'document', action: 'updated', id: 'd-1', at: 0 })

    const graphCallsSoFar = invalidateQueries.mock.calls.filter(c => JSON.stringify(c[0]!.queryKey) === JSON.stringify(['graph']))
    expect(graphCallsSoFar).toHaveLength(0) // still within the (re-armed) debounce window

    vi.advanceTimersByTime(GRAPH_DEBOUNCE_MS)

    const graphCalls = invalidateQueries.mock.calls.filter(c => JSON.stringify(c[0]!.queryKey) === JSON.stringify(['graph']))
    expect(graphCalls).toHaveLength(1)

    // The per-resource detail/list invalidations are NOT debounced — one pair per event.
    const memoryDetailCalls = invalidateQueries.mock.calls.filter(c => JSON.stringify(c[0]!.queryKey) === JSON.stringify(['memory', 'm-1']))
    expect(memoryDetailCalls).toHaveLength(1)
  })
})
