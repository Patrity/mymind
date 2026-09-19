import { describe, it, expect, vi } from 'vitest'
import { denyPendingApprovals } from './pending-approvals'

describe('denyPendingApprovals', () => {
  it('denies every pending approval, clears its timer, empties the map, returns the ids', () => {
    vi.useFakeTimers()
    const resolved: Record<string, boolean> = {}
    const fired = vi.fn()
    const m = new Map<string, { resolve: (d: { approved: boolean }) => void; timer: ReturnType<typeof setTimeout> }>()
    for (const id of ['a', 'b']) m.set(id, { resolve: d => { resolved[id] = d.approved }, timer: setTimeout(() => fired(), 1000) })
    expect(denyPendingApprovals(m)).toEqual(['a', 'b'])
    expect(resolved).toEqual({ a: false, b: false })
    expect(m.size).toBe(0)
    vi.advanceTimersByTime(2000)
    expect(fired).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
  it('is a no-op on an empty map', () => {
    expect(denyPendingApprovals(new Map())).toEqual([])
  })
})
