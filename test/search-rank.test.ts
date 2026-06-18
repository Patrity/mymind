import { describe, it, expect } from 'vitest'
import { rankCandidates, type Candidate } from '../server/lib/search/rank'

const c = (over: Partial<Candidate>): Candidate => ({
  type: 'document', id: 'x', title: 'X', snippet: null, to: '/x', icon: 'i',
  meta: null, rerankText: 'x', lexicalExact: false, rrfRank: 0, ...over
})

describe('rankCandidates', () => {
  it('with rerank scores: sorts desc and drops below cutoff', () => {
    const cands = [c({ id: 'a' }), c({ id: 'b' }), c({ id: 'c' })]
    const scores = new Map([['document:a', 0.9], ['document:b', 0.1], ['document:c', 0.5]])
    const hits = rankCandidates(cands, scores, { rerankCutoff: 0.3 })
    expect(hits.map(h => h.id)).toEqual(['a', 'c'])           // b (0.1) dropped
    expect(hits[0]).toMatchObject({ id: 'a', score: 0.9 })
  })
  it('pins exact lexical matches even below cutoff', () => {
    const cands = [c({ id: 'a' }), c({ id: 'b', lexicalExact: true })]
    const scores = new Map([['document:a', 0.9], ['document:b', 0.01]])
    const hits = rankCandidates(cands, scores, { rerankCutoff: 0.3 })
    expect(hits.map(h => h.id)).toEqual(['a', 'b'])           // b kept (pinned), ranked last
  })
  it('returns [] when nothing clears the cutoff and nothing is pinned', () => {
    const cands = [c({ id: 'a' }), c({ id: 'b' })]
    const scores = new Map([['document:a', 0.05], ['document:b', 0.02]])
    expect(rankCandidates(cands, scores, { rerankCutoff: 0.3 })).toEqual([])
  })
  it('fallback (no scores): orders by reciprocal lane rank, exact matches lead, keeps all', () => {
    const cands = [
      c({ id: 'a', rrfRank: 0 }),
      c({ id: 'b', rrfRank: 2, lexicalExact: true }),
      c({ id: 'c', rrfRank: 1 })
    ]
    const hits = rankCandidates(cands, null, { rerankCutoff: 0.3 })
    expect(hits.map(h => h.id)).toEqual(['b', 'a', 'c'])      // b boosted by lexicalExact
    expect(hits).toHaveLength(3)
  })
  it('strips internal fields from the returned SearchHit', () => {
    const hit = rankCandidates([c({ id: 'a' })], null, { rerankCutoff: 0.3 })[0]
    expect(Object.keys(hit).sort()).toEqual(['icon', 'id', 'meta', 'score', 'snippet', 'title', 'to', 'type'])
  })
})
