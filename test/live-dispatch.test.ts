import { describe, it, expect, vi } from 'vitest'
import { dispatchLiveEvent } from '../app/utils/live-dispatch'
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
  it.each(['graph', 'memory', 'document', 'image', 'session', 'project'] as const)(
    'invalidates the galaxy query (["graph"]) on a %s event',
    (resource) => {
      const invalidateQueries = vi.fn()
      dispatchLiveEvent({ invalidateQueries }, { v: 1, resource, action: 'updated', id: 'x-1', at: 0 })
      const keys = invalidateQueries.mock.calls.map(c => JSON.stringify(c[0]!.queryKey))
      expect(keys).toContain(JSON.stringify(['graph']))
    }
  )

  it('does not invalidate the galaxy query for unrelated resources', () => {
    const invalidateQueries = vi.fn()
    dispatchLiveEvent({ invalidateQueries }, { v: 1, resource: 'task', action: 'updated', id: 't-1', at: 0 })
    const keys = invalidateQueries.mock.calls.map(c => JSON.stringify(c[0]!.queryKey))
    expect(keys).not.toContain(JSON.stringify(['graph']))
  })
})
