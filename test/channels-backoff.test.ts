import { describe, it, expect } from 'vitest'
import { nextAttemptDelayMs, MAX_ATTEMPTS } from '../server/lib/channels/backoff'
it('follows 30s, 2m, 10m, 1h, 1h, 1h then gives up', () => {
  expect([0, 1, 2, 3, 4, 5].map(nextAttemptDelayMs)).toEqual([30_000, 120_000, 600_000, 3_600_000, 3_600_000, 3_600_000])
  expect(nextAttemptDelayMs(MAX_ATTEMPTS)).toBeNull()
})
