import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dispatchLiveEvent, GRAPH_DEBOUNCE_MS, HOME_DEBOUNCE_MS, REVIEW_DEBOUNCE_MS } from '../app/utils/live-dispatch'
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

  // A real review_queue decision is a single user-driven action (the actor who just
  // clicked Approve/Reject), not cron-bursty — this stays immediate, unlike the debounced
  // memory->review invalidation below.
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

describe('dispatchLiveEvent — memory -> review badge/list invalidation (debounced)', () => {
  // task-13: unreviewed memories are folded into the single /review feed, so a memory
  // update (e.g. marking one reviewed) must also refresh the review badge + list —
  // otherwise a second tab's Review badge/queue would go stale after a Mark-reviewed
  // click on a `memory-unreviewed` row. Code-review finding (Important): `memory` events
  // fire from several bursty sites (memory-resolve.ts, triage.ts, incl. the enrich-memories
  // cron's resolve path emitting several per tick) — mirrors the ['graph']/['home']
  // debounce above so a burst collapses into ONE review-badge refetch instead of one
  // countReviewPending() round-trip per event.
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('invalidates the review badge + list after the debounce window, not immediately', () => {
    const invalidateQueries = vi.fn()
    dispatchLiveEvent({ invalidateQueries }, { v: 1, resource: 'memory', action: 'updated', id: 'm-1', at: 0 })

    const keysNow = invalidateQueries.mock.calls.map(c => JSON.stringify(c[0]!.queryKey))
    expect(keysNow).not.toContain(JSON.stringify(['review', 'count']))
    expect(keysNow).not.toContain(JSON.stringify(['review', 'list']))

    vi.advanceTimersByTime(REVIEW_DEBOUNCE_MS)

    const keysAfter = invalidateQueries.mock.calls.map(c => JSON.stringify(c[0]!.queryKey))
    expect(keysAfter).toContain(JSON.stringify(['review', 'count']))
    expect(keysAfter).toContain(JSON.stringify(['review', 'list']))
  })

  it('collapses a burst of memory events into ONE review-badge/list invalidation', () => {
    const invalidateQueries = vi.fn()
    const client = { invalidateQueries }

    // Simulate an enrich-memories-cron-style burst of memory events within the window.
    for (let i = 0; i < 5; i++) {
      dispatchLiveEvent(client, { v: 1, resource: 'memory', action: 'updated', id: `m-${i}`, at: 0 })
      vi.advanceTimersByTime(REVIEW_DEBOUNCE_MS / 2)
    }

    const reviewCallsSoFar = invalidateQueries.mock.calls.filter(c => JSON.stringify(c[0]!.queryKey) === JSON.stringify(['review', 'count']))
    expect(reviewCallsSoFar).toHaveLength(0) // still within the (re-armed) debounce window

    vi.advanceTimersByTime(REVIEW_DEBOUNCE_MS)

    const reviewCountCalls = invalidateQueries.mock.calls.filter(c => JSON.stringify(c[0]!.queryKey) === JSON.stringify(['review', 'count']))
    const reviewListCalls = invalidateQueries.mock.calls.filter(c => JSON.stringify(c[0]!.queryKey) === JSON.stringify(['review', 'list']))
    expect(reviewCountCalls).toHaveLength(1)
    expect(reviewListCalls).toHaveLength(1)

    // The per-event memory detail/list invalidations are NOT debounced — one pair per event.
    const memoryDetailCalls = invalidateQueries.mock.calls.filter(c => JSON.stringify(c[0]!.queryKey) === JSON.stringify(['memory', 'm-0']))
    expect(memoryDetailCalls).toHaveLength(1)
  })

  it('does not invalidate the review keys for an unrelated resource', () => {
    const invalidateQueries = vi.fn()
    dispatchLiveEvent({ invalidateQueries }, { v: 1, resource: 'task', action: 'updated', id: 't-1', at: 0 })
    vi.advanceTimersByTime(REVIEW_DEBOUNCE_MS)
    const keys = invalidateQueries.mock.calls.map(c => JSON.stringify(c[0]!.queryKey))
    expect(keys).not.toContain(JSON.stringify(['review', 'count']))
    expect(keys).not.toContain(JSON.stringify(['review', 'list']))
  })
})

describe('home invalidation', () => {
  const HOME_RESOURCES = [
    'document', 'image', 'memory', 'review',
    'project', 'task', 'session', 'clipboard', 'activity'
  ] as const

  it('every home-feeding resource eventually invalidates ["home"]', async () => {
    for (const resource of HOME_RESOURCES) {
      const calls: unknown[][] = []
      const client = { invalidateQueries: (a: unknown) => { calls.push([a]); return Promise.resolve() } }
      dispatchLiveEvent(client, { v: 1, resource, action: 'created', id: 'x', at: Date.now() })
      await new Promise(r => setTimeout(r, HOME_DEBOUNCE_MS + 60))
      const keys = calls.map(c => JSON.stringify((c[0] as { queryKey: unknown }).queryKey))
      expect(keys, `resource=${resource}`).toContain(JSON.stringify(['home']))
    }
  }, 15000)

  it('collapses a burst into a single ["home"] invalidation', async () => {
    const calls: unknown[][] = []
    const client = { invalidateQueries: (a: unknown) => { calls.push([a]); return Promise.resolve() } }
    for (let i = 0; i < 12; i++) {
      dispatchLiveEvent(client, { v: 1, resource: 'memory', action: 'created', id: `m${i}`, at: Date.now() })
    }
    await new Promise(r => setTimeout(r, HOME_DEBOUNCE_MS + 60))
    const homeCalls = calls.filter(c =>
      JSON.stringify((c[0] as { queryKey: unknown }).queryKey) === JSON.stringify(['home']))
    expect(homeCalls).toHaveLength(1)
  })
})