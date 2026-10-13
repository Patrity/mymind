import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dispatchLiveEvent, evalQueryTouched, EVAL_DEBOUNCE_MS, GRAPH_DEBOUNCE_MS, HOME_DEBOUNCE_MS, REVIEW_DEBOUNCE_MS, WORKSTREAM_LIST_DEBOUNCE_MS } from '../app/utils/live-dispatch'
import type { LiveEvent } from '@mymind/core/shared/types/live'

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

  // Prompt macros still publish `document`, so the composer's `/` menu
  // (useCommands, ['agent','commands']) must refresh on a document event.
  it('document events also invalidate the command menu', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'document', id: 'd-1' }))
    expect(c.calls).toContainEqual([{ queryKey: ['agent', 'commands'] }])
  })

  // Cycle 74: skills live in agent_skills with their own resource — a skill write must refresh
  // the skills list AND the `/` menu (active skills are a command source).
  it('agentSkill events invalidate the skills list and the command menu', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'agentSkill', id: 's-1' }))
    expect(c.calls).toContainEqual([{ queryKey: ['skills'] }])
    expect(c.calls).toContainEqual([{ queryKey: ['agent', 'commands'] }])
  })

  // Cycle 74: /jobs keys everything under ['jobs'] (list, source, revisions) — none of which the
  // default ['agentJob', …] invalidations reach.
  it('agentJob events invalidate the bare ["jobs"] prefix', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'agentJob', id: 'j-1' }))
    expect(c.calls).toContainEqual([{ queryKey: ['jobs'] }])
  })

  // Cycle 76 (Task 2): Settings -> Profile reads under ['profile', …] (queryBase 'profile'),
  // not the default ['agentProfile', …] the base invalidations below would produce.
  it('agentProfile events invalidate the bare ["profile"] prefix', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'agentProfile', id: 'p-1' }))
    expect(c.calls).toContainEqual([{ queryKey: ['profile'] }])
  })

  // Cycle 77: Settings -> Memory's backfill card reads its progress under ['memory-backfill'].
  it('memoryBackfill events invalidate the ["memory-backfill"] key', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'memoryBackfill', id: 'memory_backfill' }))
    expect(c.calls).toContainEqual([{ queryKey: ['memory-backfill'] }])
  })

  // Cycle 76 (Task 7): a pending improvement is a /review card.
  it('agentImprovement events invalidate the ["review"] and ["agentImprovement"] prefixes', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'agentImprovement', id: 'i-1' }))
    expect(c.calls).toContainEqual([{ queryKey: ['review'] }])
    expect(c.calls).toContainEqual([{ queryKey: ['agentImprovement'] }])
  })
})

describe('dispatchLiveEvent — agentRun', () => {
  // The Runs drawer's query key is ['agentRun', conversationId], not the default
  // [resource, 'list'] — and the event's `id` is the RUN's id, never a conversationId, so
  // the default [resource, id] invalidation can't help either. Only a bare ['agentRun']
  // prefix invalidation (tanstack's fuzzy matching) reaches every conversationId variant.
  it('invalidates the bare ["agentRun"] prefix, not just [resource, id] / [resource, "list"]', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'agentRun', id: 'run-1' }))
    expect(c.calls).toContainEqual([{ queryKey: ['agentRun'] }])
  })
})

describe('dispatchLiveEvent — channelDelivery', () => {
  // Cycle 75: a channel delivery is shown inline in the conversation it replied to — an open
  // thread view (keyed under ['conversation', ...]) must refresh when a send lands or fails.
  it('invalidates the ["conversation"] prefix', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'channelDelivery', id: 'cd-1' }))
    expect(c.calls).toContainEqual([{ queryKey: ['conversation'] }])
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
describe('dispatchLiveEvent — resync (cycle 81)', () => {
  it('a resync event invalidates every query, and nothing resource-specific', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'resync', id: 'bus-reconnect' }))
    expect(c.calls).toEqual([[undefined]])
  })
})

describe('dispatchLiveEvent — workstream list (debounced, cycle 83 final fix wave M1)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('the detail key is immediate; a burst of tree steps collapses into ONE list refetch', () => {
    const c = fakeClient()
    for (let i = 0; i < 12; i++) dispatchLiveEvent(c as never, ev({ resource: 'workstream', id: `ws-${i % 3}` }))
    expect(c.calls).toContainEqual([{ queryKey: ['workstream', 'ws-0'] }])
    const lists = () => c.calls.filter(([a]) => JSON.stringify((a as { queryKey: unknown }).queryKey) === JSON.stringify(['workstream', 'list'])).length
    expect(lists()).toBe(0)
    vi.advanceTimersByTime(WORKSTREAM_LIST_DEBOUNCE_MS / 2)
    expect(lists()).toBe(0)
    vi.advanceTimersByTime(WORKSTREAM_LIST_DEBOUNCE_MS)
    expect(lists()).toBe(1)
  })
})

// Cycle 85 fix round 1: eval events are collected and flushed once per EVAL_DEBOUNCE_MS, scoped.
describe('eval live dispatch (debounced, scoped)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  type Call = { queryKey: unknown[]; predicate?: (q: { queryKey: unknown[]; state: { data: unknown } }) => boolean }
  const evalEv = (id: string): LiveEvent => ({ v: 1, resource: 'eval', action: 'updated', id, at: 0 })

  it('a burst of events is ONE flush after the quiet window, with no dead [eval, id] / [eval, list] keys', () => {
    const invalidateQueries = vi.fn()
    const c = { invalidateQueries } as never
    for (let i = 0; i < 20; i++) { dispatchLiveEvent(c, evalEv('run-1')); vi.advanceTimersByTime(EVAL_DEBOUNCE_MS / 4) }
    expect(invalidateQueries).not.toHaveBeenCalled()
    vi.advanceTimersByTime(EVAL_DEBOUNCE_MS)
    const keys = invalidateQueries.mock.calls.map(x => JSON.stringify((x[0] as Call).queryKey))
    expect(keys).toEqual([JSON.stringify(['eval', 'suites']), JSON.stringify(['eval', 'suite']), JSON.stringify(['eval'])])
  })

  it('the scoped flush refetches only the run / attempt / case views whose ids changed', () => {
    const invalidateQueries = vi.fn()
    const c = { invalidateQueries } as never
    dispatchLiveEvent(c, evalEv('run-1'))
    dispatchLiveEvent(c, evalEv('case-7'))
    vi.advanceTimersByTime(EVAL_DEBOUNCE_MS)
    const scoped = invalidateQueries.mock.calls.map(x => x[0] as Call).find(a => a.predicate)!
    const hit = (queryKey: unknown[], data: unknown = undefined) => scoped.predicate!({ queryKey, state: { data } })
    expect(hit(['eval', 'run', 'run-1'])).toBe(true)
    expect(hit(['eval', 'run', 'run-2'])).toBe(false)
    expect(hit(['eval', 'case', 'case-7'])).toBe(true)
    expect(hit(['eval', 'attempt', 'res-1'], { run: { id: 'run-9' }, case: { id: 'case-7' } })).toBe(true)
    expect(hit(['eval', 'attempt', 'res-2'], { run: { id: 'run-9' }, case: { id: 'case-8' } })).toBe(false)
    // The suite views are refreshed by their own (unscoped) call, never twice by the predicate.
    expect(hit(['eval', 'suite', 'run-1'])).toBe(false)
    // The next window starts empty.
    invalidateQueries.mockClear()
    dispatchLiveEvent(c, evalEv('run-2'))
    vi.advanceTimersByTime(EVAL_DEBOUNCE_MS)
    const next = invalidateQueries.mock.calls.map(x => x[0] as Call).find(a => a.predicate)!
    expect(next.predicate!({ queryKey: ['eval', 'run', 'run-1'], state: { data: undefined } })).toBe(false)
  })

  it('evalQueryTouched matches an attempt by its run', () => {
    expect(evalQueryTouched(['eval', 'attempt', 'r'], { run: { id: 'x' }, case: null }, new Set(['x']))).toBe(true)
    expect(evalQueryTouched(['eval', 'attempt', 'r'], undefined, new Set(['x']))).toBe(false)
  })
})
