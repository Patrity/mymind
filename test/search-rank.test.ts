import { describe, it, expect } from 'vitest'
import { rankCandidates, type Candidate } from '../server/lib/search/rank'

const c = (over: Partial<Candidate>): Candidate => ({
  type: 'document', id: 'x', title: 'X', snippet: null, to: '/x', icon: 'i',
  meta: null, rerankText: 'x', lexicalExact: false, rrfRank: 0, ...over
})
const CFG = { topK: 12, relBand: 0.5 }

describe('rankCandidates', () => {
  it('reranked: drops below the relative band (relBand × topScore)', () => {
    // top=1.0, band 0.5 → threshold 0.5: keep 1.0 and 0.6, drop 0.3
    const cands = [c({ id: 'a' }), c({ id: 'b' }), c({ id: 'c' })]
    const scores = new Map([['document:a', 1.0], ['document:b', 0.3], ['document:c', 0.6]])
    const hits = rankCandidates(cands, scores, CFG)
    expect(hits.map(h => h.id)).toEqual(['a', 'c'])  // b (0.3) dropped — a fixed 0.2 cutoff would've kept it
    expect(hits[0]).toMatchObject({ id: 'a', score: 1 })
  })
  it('band is relative to the top score, not absolute', () => {
    // top=0.4, band 0.5 → threshold 0.2: keep 0.4 and 0.25, drop 0.1
    const cands = [c({ id: 'a' }), c({ id: 'b' }), c({ id: 'c' })]
    const scores = new Map([['document:a', 0.4], ['document:b', 0.1], ['document:c', 0.25]])
    const hits = rankCandidates(cands, scores, CFG)
    expect(hits.map(h => h.id)).toEqual(['a', 'c'])  // c (0.25) kept though a fixed 0.5 cutoff would drop it
  })
  it('pins exact lexical matches even below the band', () => {
    const cands = [c({ id: 'a' }), c({ id: 'b', lexicalExact: true })]
    const scores = new Map([['document:a', 1.0], ['document:b', 0.01]])
    const hits = rankCandidates(cands, scores, CFG)
    expect(hits.map(h => h.id)).toEqual(['a', 'b'])  // b kept (pinned), ranked last
  })
  it('caps the reranked result to topK', () => {
    const cands = Array.from({ length: 5 }, (_, i) => c({ id: `d${i}` }))
    const scores = new Map(cands.map((_, i) => [`document:d${i}`, 1 - i * 0.01]))  // all ~1.0, within band
    const hits = rankCandidates(cands, scores, { topK: 3, relBand: 0.5 })
    expect(hits.map(h => h.id)).toEqual(['d0', 'd1', 'd2'])
  })
  it('non-empty pool always yields ≥1 hit (top clears its own band)', () => {
    const cands = [c({ id: 'a' }), c({ id: 'b' })]
    const scores = new Map([['document:a', 0.05], ['document:b', 0.02]])
    const hits = rankCandidates(cands, scores, CFG)
    expect(hits.map(h => h.id)).toEqual(['a'])  // a is the top (0.05>=0.025); b (0.02<0.025) dropped
  })
  it('empty pool → []', () => {
    expect(rankCandidates([], new Map(), CFG)).toEqual([])
    expect(rankCandidates([], null, CFG)).toEqual([])
  })
  it('fallback (no scores): reciprocal lane rank, exact matches lead', () => {
    const cands = [
      c({ id: 'a', rrfRank: 0 }),
      c({ id: 'b', rrfRank: 2, lexicalExact: true }),
      c({ id: 'c', rrfRank: 1 })
    ]
    const hits = rankCandidates(cands, null, CFG)
    expect(hits.map(h => h.id)).toEqual(['b', 'a', 'c'])  // b boosted by lexicalExact
  })
  it('fallback caps to topK', () => {
    const cands = Array.from({ length: 5 }, (_, i) => c({ id: `e${i}`, rrfRank: i }))
    const hits = rankCandidates(cands, null, { topK: 2, relBand: 0.5 })
    expect(hits.map(h => h.id)).toEqual(['e0', 'e1'])
  })
  it('strips internal fields from the returned SearchHit', () => {
    const hit = rankCandidates([c({ id: 'a' })], null, CFG)[0]
    expect(Object.keys(hit).sort()).toEqual(['icon', 'id', 'meta', 'score', 'snippet', 'title', 'to', 'type'])
  })
})
