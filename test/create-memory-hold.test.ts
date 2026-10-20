// D3 A4 (2026-10-20): createMemory gains `holdForReview` (mirrors memory-resolve's insertFresh) so a
// secret-flagged save_memory / manual memory is inserted UNREVIEWED regardless of confidence or
// `reviewed: true`, and surfaces in /review as a memory-unreviewed card instead of entering recall.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@mymind/core/lib/ai/embeddings', () => ({ embedOne: vi.fn(async () => [0.1, 0.2, 0.3]) }))
vi.mock('@mymind/core/config', () => ({ coreConfig: () => ({ memoryAutoReviewThreshold: 0.75 }) }))
vi.mock('@mymind/core/utils/live-bus', () => ({ publishChange: vi.fn() }))

// Chainable DB stub (same shape as memory-resolve-secret-gate.test.ts): awaited queries resolve to the
// next queued result; `.values()` records the inserted row.
const results: unknown[][] = []
const inserted: Record<string, unknown>[] = []
function builder(): unknown {
  const self: unknown = new Proxy({}, {
    get(_t, key) {
      if (key === 'then') return (res: (v: unknown) => void) => res(results.shift() ?? [])
      if (key === 'values') {
        return (row: Record<string, unknown>) => {
          inserted.push(row)
          return self
        }
      }
      return () => self
    }
  })
  return self
}
vi.mock('@mymind/core/db', () => ({ useDb: () => builder() }))

import { createMemory } from '@mymind/core/services/memory'

const row = (over: Record<string, unknown>) => [{ id: 'mem-1', scope: 'user', content: 'x', tags: [], evidence: [], createdAt: new Date(), updatedAt: new Date(), ...over }]

beforeEach(() => {
  inserted.length = 0
  results.length = 0
  // exact-hash lookup → none; vector lookup → none; insert … returning → the new row
  results.push([], [], row({}))
})

describe('createMemory — holdForReview', () => {
  it('inserts with reviewed_at NULL when held, even at auto-review confidence with reviewed: true', async () => {
    await createMemory({ content: 'x', confidence: 0.95, reviewed: true, tags: ['needs-review:secret'], holdForReview: true })
    expect(inserted[0]!.reviewedAt).toBeNull()
    expect(inserted[0]!.tags).toEqual(['needs-review:secret'])
    expect(inserted[0]!.confidence).toBe(0.95)
  })

  it('auto-reviews exactly as before when not held', async () => {
    await createMemory({ content: 'x', confidence: 0.95 })
    expect(inserted[0]!.reviewedAt).toBeInstanceOf(Date)
  })

  it('leaves a low-confidence memory unreviewed exactly as before when not held', async () => {
    await createMemory({ content: 'x', confidence: 0.2 })
    expect(inserted[0]!.reviewedAt).toBeNull()
  })
})
