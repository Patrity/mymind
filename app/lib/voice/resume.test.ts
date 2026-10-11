import { describe, it, expect } from 'vitest'
import { createResumeTracker } from './resume'

describe('createResumeTracker', () => {
  it('keeps the highest seq rendered per run of the thread on screen', () => {
    const t = createResumeTracker()
    t.observe({ cid: 'c1', run: 'r1', seq: 3 })
    t.observe({ cid: 'c1', run: 'r1', seq: 2 }) // out of order never lowers it
    t.observe({ cid: 'c1', run: 'r2', seq: 9 })
    t.observe({ cid: 'c1' }) // a socket-direct frame (no run/seq) is ignored
    expect(t.point('c1')).toEqual({ conversationId: 'c1', after: { r1: 3, r2: 9 } })
  })

  it('a new thread with no id yet resumes the thread its running turn named', () => {
    const t = createResumeTracker()
    t.observe({ cid: 'c-new', run: 'r1', seq: 4 })
    expect(t.point(null)).toEqual({ conversationId: 'c-new', after: { r1: 4 } })
  })

  it('another thread starts fresh; clear() forgets everything', () => {
    const t = createResumeTracker()
    t.observe({ cid: 'c1', run: 'r1', seq: 3 })
    expect(t.point('c2')).toEqual({ conversationId: 'c2', after: {} })
    t.observe({ cid: 'c2', run: 'r5', seq: 1 })
    expect(t.point('c2')).toEqual({ conversationId: 'c2', after: { r5: 1 } })
    t.clear()
    expect(t.point(null)).toBeNull()
  })
})
