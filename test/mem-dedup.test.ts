import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cosine, dedupDecision, type DedupCandidate } from '../server/services/memory-dedup'

const DIM = 8 // small dimension for tests

function makeVec(val: number): number[] {
  const v = Array(DIM).fill(0)
  v[0] = val
  return v
}

describe('cosine', () => {
  it('identical vectors have cosine ≈ 1', () => {
    const v = makeVec(1)
    expect(cosine(v, v)).toBeCloseTo(1, 5)
  })

  it('orthogonal vectors have cosine ≈ 0', () => {
    const a = [1, 0, 0, 0, 0, 0, 0, 0]
    const b = [0, 1, 0, 0, 0, 0, 0, 0]
    expect(cosine(a, b)).toBeCloseTo(0, 5)
  })

  it('zero vector returns 0 (no NaN)', () => {
    const zero = Array(DIM).fill(0)
    expect(cosine(zero, makeVec(1))).toBe(0)
    expect(cosine(makeVec(1), zero)).toBe(0)
  })

  it('antiparallel vectors have cosine ≈ -1', () => {
    const a = makeVec(1)
    const b = makeVec(-1)
    expect(cosine(a, b)).toBeCloseTo(-1, 5)
  })
})

describe('dedupDecision', () => {
  const hashA = 'hash-aaa'
  const hashB = 'hash-bbb'
  const hashC = 'hash-ccc'

  const vecA = makeVec(1)            // unit along axis 0
  const vecB = [0.9999, 0.01, 0, 0, 0, 0, 0, 0]  // very close to vecA
  const vecOrtho = [0, 1, 0, 0, 0, 0, 0, 0]       // orthogonal to vecA

  const existingA: DedupCandidate = { id: 'id-a', contentHash: hashA, embedding: vecA }
  const existingOrtho: DedupCandidate = { id: 'id-ortho', contentHash: hashC, embedding: vecOrtho }

  it('exact hash match → skip with mergeId', () => {
    const result = dedupDecision(
      { contentHash: hashA, embedding: vecA },
      [existingA]
    )
    expect(result.action).toBe('skip')
    expect(result.mergeId).toBe('id-a')
  })

  it('near-identical embedding (sim ≥ 0.85) with different hash → merge', () => {
    const result = dedupDecision(
      { contentHash: hashB, embedding: vecB },
      [existingA]
    )
    expect(result.action).toBe('merge')
    expect(result.mergeId).toBe('id-a')
  })

  it('all-far embeddings → insert', () => {
    const result = dedupDecision(
      { contentHash: hashB, embedding: vecOrtho },
      [existingA]
    )
    expect(result.action).toBe('insert')
    expect(result.mergeId).toBeUndefined()
  })

  it('empty existing → insert', () => {
    const result = dedupDecision(
      { contentHash: hashB, embedding: vecA },
      []
    )
    expect(result.action).toBe('insert')
  })

  it('merges to the closest candidate when multiple exist above threshold', () => {
    const vecCloser = [0.9999, 0.005, 0, 0, 0, 0, 0, 0]  // even closer to vecA
    const vecClose  = [0.9990, 0.04,  0, 0, 0, 0, 0, 0]  // still above threshold but further
    const existingClose: DedupCandidate  = { id: 'id-close',  contentHash: 'hc', embedding: vecClose }
    const existingCloser: DedupCandidate = { id: 'id-closer', contentHash: 'hd', embedding: vecCloser }

    const result = dedupDecision(
      { contentHash: hashB, embedding: vecA },
      [existingClose, existingCloser]
    )
    expect(result.action).toBe('merge')
    expect(result.mergeId).toBe('id-closer')
  })

  it('candidates with null embedding are skipped in semantic comparison', () => {
    const nullEmbedding: DedupCandidate = { id: 'id-null', contentHash: 'hn', embedding: null }
    const result = dedupDecision(
      { contentHash: hashB, embedding: vecA },
      [nullEmbedding]
    )
    // no hash match, no valid embedding to compare → insert
    expect(result.action).toBe('insert')
  })

  it('custom threshold is respected', () => {
    // vecB is very close to vecA (sim >> 0.85) but set threshold = 1.0 (impossible)
    const result = dedupDecision(
      { contentHash: hashB, embedding: vecB },
      [existingA],
      { threshold: 1.0 }
    )
    expect(result.action).toBe('insert')
  })
})

// ---------------------------------------------------------------------------
// dedupMemoriesAfterMerge — unit-testable surface (pure zero-input case)
// ---------------------------------------------------------------------------

describe('dedupMemoriesAfterMerge', () => {
  // We cannot stand up a real DB in unit tests, but we can verify the zero-input
  // short-circuit that is purely in-process and requires no database at all.
  // 15s timeout: the dynamic import pulls the whole services/memory graph, which
  // under full-suite parallel load can alone exceed the 5s default (observed flake).
  it('returns { collapsed: 0 } immediately when given an empty id list', async () => {
    // Dynamically import so the module-level mocks (useDb etc.) are not needed
    // for this particular code path — the function returns early before any DB call.
    const { dedupMemoriesAfterMerge } = await import('../server/services/memory')
    const result = await dedupMemoriesAfterMerge([])
    expect(result).toEqual({ collapsed: 0 })
  }, 15_000)
})
