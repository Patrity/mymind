import { describe, it, expect } from 'vitest'
import { parseRerankResponse } from '@mymind/core/lib/ai/rerank'

describe('parseRerankResponse', () => {
  const ids = ['a', 'b', 'c']
  it('maps results[].{index,score} → {id,score} sorted desc by raw score', () => {
    // Task-1 spike confirmed the rig (TEI Qwen3-Reranker-0.6B-seq-cls) returns `score`.
    const raw = { results: [
      { index: 0, score: 0.10 },
      { index: 1, score: 0.90 },
      { index: 2, score: 0.40 }
    ] }
    expect(parseRerankResponse(raw, ids)).toEqual([
      { id: 'b', score: 0.90 },
      { id: 'c', score: 0.40 },
      { id: 'a', score: 0.10 }
    ])
  })
  it('keeps raw scores (no min-max normalisation)', () => {
    const raw = { results: [{ index: 0, score: 0.7 }, { index: 1, score: 0.5 }] }
    const out = parseRerankResponse(raw, ['x', 'y'])
    expect(out[0]).toEqual({ id: 'x', score: 0.7 }) // top is NOT forced to 1.0
    expect(out[1]).toEqual({ id: 'y', score: 0.5 }) // bottom is NOT forced to 0.0
  })
  it('falls back to relevance_score when score is absent (TEI variants)', () => {
    const raw = { results: [{ index: 0, relevance_score: 0.42 }] }
    expect(parseRerankResponse(raw, ['a'])).toEqual([{ id: 'a', score: 0.42 }])
  })
  it('tolerates a bare array and out-of-range indices', () => {
    expect(parseRerankResponse([{ index: 1, score: 0.3 }], ['a', 'b']))
      .toEqual([{ id: 'b', score: 0.3 }])
    expect(parseRerankResponse({ results: [{ index: 9, score: 0.9 }] }, ['a']))
      .toEqual([]) // index 9 has no id → dropped
  })
})

describe('rerank query clipping', () => {
  it('sends at most RERANK_QUERY_MAX characters of the query', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const fetchSpy = vi.fn().mockResolvedValue({ results: [{ index: 0, relevance_score: 0.9 }] })
    vi.stubGlobal('$fetch', fetchSpy)
    const { rerank, RERANK_QUERY_MAX } = await import('@mymind/core/lib/ai/rerank')
    await rerank('x'.repeat(RERANK_QUERY_MAX * 5), [{ id: 'a', text: 'doc' }], 'http://gw', 'k', 'm')
    const body = (fetchSpy.mock.calls[0]![1] as { body: { query: string } }).body
    expect(body.query).toHaveLength(RERANK_QUERY_MAX)
    vi.unstubAllGlobals()
  })
})
