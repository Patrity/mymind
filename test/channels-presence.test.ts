// Cycle 75, Task 3: in-memory presence — away until a ping, active for presenceAwayMinutes.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../server/lib/channels/config', () => ({
  loadChannelsConfig: vi.fn(async () => ({ presenceAwayMinutes: 10 }))
}))

import { markActive, isAway, _resetPresence } from '../server/lib/channels/presence'

const MIN = 60_000

describe('presence', () => {
  beforeEach(() => _resetPresence())

  it('is away with no ping', async () => {
    expect(await isAway(Date.now())).toBe(true)
  })
  it('is not away right after markActive()', async () => {
    markActive()
    expect(await isAway()).toBe(false)
  })
  it('is away again after presenceAwayMinutes', async () => {
    const t0 = 1_000_000_000_000
    markActive(t0)
    expect(await isAway(t0 + 10 * MIN - 1)).toBe(false)
    expect(await isAway(t0 + 10 * MIN)).toBe(true)
  })
  it('a later ping extends the window', async () => {
    const t0 = 1_000_000_000_000
    markActive(t0)
    markActive(t0 + 5 * MIN)
    expect(await isAway(t0 + 12 * MIN)).toBe(false)
  })
})
