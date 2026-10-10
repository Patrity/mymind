// test/jobs-seed-digest.test.ts
// The self-improvement digest seed stays quiet unless something happened TODAY (cycle 76 final
// review m4): one proposal left undecided must not produce a digest every night.
import { describe, it, expect } from 'vitest'
import { SEED_JOBS } from '@mymind/core/lib/agent/jobs/seeds'
import { parseJob } from '@mymind/core/lib/agent/jobs/parse'

const digest = SEED_JOBS['self-improvement-digest']

describe('self-improvement-digest seed', () => {
  it('replies NO_REPLY unless something was applied or raised today; the live pending count alone is not a reason', () => {
    expect(digest).toContain("Reply NO_REPLY unless one of today's items is applied, or was raised today and is still pending_review or conflict.")
    expect(digest).toContain('Proposals still waiting from earlier days (pendingReview) are not a reason to write.')
    expect(digest).not.toContain('nothing pending review, reply NO_REPLY')
  })

  it('is still a valid, disabled job', () => {
    const parsed = parseJob(digest, { defaultTimezone: 'America/New_York' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.spec.enabled).toBe(false)
  })
})
