import { describe, it, expect } from 'vitest'
import { splitOrigin } from './event-origin'

describe('splitOrigin', () => {
  it('keeps everything after the first colon as the detail (a job wake keeps its slug)', () => {
    expect(splitOrigin('wake:job:morning-brief')).toEqual({ kind: 'wake', detail: 'job:morning-brief' })
  })
  it('splits a plain two-part origin', () => {
    expect(splitOrigin('review:approved')).toEqual({ kind: 'review', detail: 'approved' })
  })
  it('an origin with no colon is all kind; null/empty is empty', () => {
    expect(splitOrigin('runtime')).toEqual({ kind: 'runtime', detail: '' })
    expect(splitOrigin(null)).toEqual({ kind: '', detail: '' })
  })
})
