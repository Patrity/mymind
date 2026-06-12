import { describe, it, expect } from 'vitest'
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
