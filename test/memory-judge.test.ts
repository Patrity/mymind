import { describe, it, expect } from 'vitest'
import { parseJudgement } from '../server/lib/ai/memory-judge'

describe('parseJudgement', () => {
  const ids = ['m1', 'm2']
  it('parses verdicts, keeps only known ids + valid relations', () => {
    const r = parseJudgement('{"verdicts":[{"existingId":"m1","relation":"refines","confidence":0.8,"reasoning":"newer"},{"existingId":"zzz","relation":"duplicate","confidence":0.9}]}', ids)
    expect(r).toEqual([{ existingId: 'm1', relation: 'refines', confidence: 0.8, reasoning: 'newer' }])
  })
  it('tolerates fences + clamps confidence; defaults unknown relation to unrelated', () => {
    const r = parseJudgement('```json\n{"verdicts":[{"existingId":"m2","relation":"bogus","confidence":2}]}\n```', ids)
    expect(r[0]).toMatchObject({ existingId: 'm2', relation: 'unrelated', confidence: 1 })
  })
  it('returns [] on garbage', () => { expect(parseJudgement('nope', ids)).toEqual([]) })
})
