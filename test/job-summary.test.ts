import { describe, it, expect } from 'vitest'
import { jobDidWork } from '../server/lib/observability/job-summary'

describe('jobDidWork', () => {
  it('false for an all-zero embed result (a no-op tick)', () => {
    expect(jobDidWork({ embedded: 0, failed: 0, remaining: 0 })).toBe(false)
  })

  it('true when work was actually done', () => {
    expect(jobDidWork({ embedded: 3, failed: 0, remaining: 0 })).toBe(true)
  })

  it('true when something failed (worth surfacing even with no successes)', () => {
    expect(jobDidWork({ embedded: 0, failed: 2, remaining: 5 })).toBe(true)
  })

  it('ignores a positive `remaining` backlog — that is a gauge, not work performed', () => {
    expect(jobDidWork({ embedded: 0, failed: 0, remaining: 42 })).toBe(false)
  })

  it('reads top-level counters and ignores nested/non-numeric fields', () => {
    expect(jobDidWork({
      enriched: 0, candidates: 0, sessionsProcessed: 0, skipped: 0,
      actions: { inserted: 0, duplicate: 0 }
    })).toBe(false)
    expect(jobDidWork({
      enriched: 2, candidates: 2, sessionsProcessed: 1, skipped: 0,
      actions: { inserted: 2 }
    })).toBe(true)
  })
})
