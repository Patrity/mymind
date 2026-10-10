// test/agent-steer.test.ts
import { describe, it, expect } from 'vitest'
import { spliceSteers } from '@mymind/core/lib/agent/runtime/steer'

describe('spliceSteers', () => {
  it('inserts each steer at the position it arrived, and keeps it there on later steps', () => {
    const step2 = ['sys-free-history', 'user:q', 'asst:tool-call', 'tool:result']
    const marks = [{ at: 4, text: 'actually use the other doc' }]
    expect(spliceSteers(step2, marks)).toEqual([...step2, { role: 'user', content: 'actually use the other doc' }])
    const step3 = [...step2, 'asst:tool-call-2', 'tool:result-2']
    expect(spliceSteers(step3, marks)).toEqual([...step2, { role: 'user', content: 'actually use the other doc' }, 'asst:tool-call-2', 'tool:result-2'])
  })
  it('keeps several steers in arrival order', () => {
    const r = spliceSteers(['a', 'b'], [{ at: 1, text: 's1' }, { at: 2, text: 's2' }])
    expect(r).toEqual(['a', { role: 'user', content: 's1' }, 'b', { role: 'user', content: 's2' }])
  })
})
