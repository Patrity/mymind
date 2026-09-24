import { describe, it, expect } from 'vitest'
import { extractFeatures, relevanceScore, rankForContext, WEIGHTS } from '../server/lib/agent/salience'
import type { MemoryDTO } from '../shared/types/memory'

const NOW = new Date('2026-09-23T00:00:00.000Z')

const mem = (id: string, over: Partial<MemoryDTO> = {}): MemoryDTO => ({
  id, scope: 'agent', content: `memory ${id}`, tags: [], source: null, confidence: null,
  project: null, applicability: 'project', resident: false, sessionId: null, enrichedAt: null,
  reviewedAt: '2026-09-01T00:00:00.000Z', sourceDate: '2026-09-20T00:00:00.000Z',
  createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
  relevance: 0.5, ...over
})

const ctx = (over: Partial<Parameters<typeof extractFeatures>[1]> = {}) =>
  ({ now: NOW, contradictedIds: new Set<string>(), ...over })

describe('extractFeatures', () => {
  it('reads age in days from sourceDate', () => {
    expect(extractFeatures(mem('a'), ctx()).ageDays).toBe(3)
  })

  it('falls back to createdAt when sourceDate is null', () => {
    expect(extractFeatures(mem('a', { sourceDate: null }), ctx()).ageDays).toBe(3)
  })

  it('marks a project match', () => {
    const f = extractFeatures(mem('a', { project: 'mymind' }), ctx({ projectSlug: 'mymind' }))
    expect(f.projectMatch).toBe(true)
  })

  it('marks an unreviewed memory as untrusted', () => {
    expect(extractFeatures(mem('a', { reviewedAt: null }), ctx()).reviewed).toBe(false)
  })

  it('marks a contradicted memory', () => {
    expect(extractFeatures(mem('a'), ctx({ contradictedIds: new Set(['a']) })).contradicted).toBe(true)
  })
})

describe('relevanceScore — each weight in isolation', () => {
  const base = extractFeatures(mem('a'), ctx())

  it('rises with semantic relevance', () => {
    expect(relevanceScore({ ...base, relevance: 0.9 })).toBeGreaterThan(relevanceScore({ ...base, relevance: 0.1 }))
  })

  it('rewards a contradiction — it is the most important thing to surface', () => {
    expect(relevanceScore({ ...base, contradicted: true })).toBeGreaterThan(relevanceScore(base))
    expect(WEIGHTS.contradicted).toBeGreaterThan(0)
  })

  it('penalises an unreviewed memory', () => {
    expect(relevanceScore({ ...base, reviewed: false })).toBeLessThan(relevanceScore(base))
  })

  it('prefers recent over old, all else equal', () => {
    expect(relevanceScore({ ...base, ageDays: 1 })).toBeGreaterThan(relevanceScore({ ...base, ageDays: 900 }))
  })

  it('rewards a project match', () => {
    expect(relevanceScore({ ...base, projectMatch: true })).toBeGreaterThan(relevanceScore(base))
  })
})

describe('rankForContext', () => {
  it('puts a contradicted memory above a merely relevant one', () => {
    const ranked = rankForContext(
      [mem('plain', { relevance: 0.8 }), mem('bad', { relevance: 0.4 })],
      ctx({ contradictedIds: new Set(['bad']) })
    )
    expect(ranked[0]!.id).toBe('bad')
  })

  it('is stable for equal scores — no arbitrary reordering between turns', () => {
    const input = [mem('a'), mem('b'), mem('c')]
    expect(rankForContext(input, ctx()).map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns every input memory, dropping none', () => {
    expect(rankForContext([mem('a'), mem('b')], ctx())).toHaveLength(2)
  })
})
