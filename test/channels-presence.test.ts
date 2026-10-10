// Cycle 75, Task 3: in-memory presence — away until a ping, active for presenceAwayMinutes.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@mymind/core/lib/channels/config', () => ({
  loadChannelsConfig: vi.fn(async () => ({ presenceAwayMinutes: 10 }))
}))

import { markActive, isAway, _resetPresence, channelPresence } from '@mymind/core/lib/channels/presence'

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

// Cycle 75, Task 8: a run answering an iMessage marks the chat read and shows typing while it
// works. Fire-and-forget: failures are logged, never thrown into the run.
describe('channelPresence', () => {
  const CHAT = 'iMessage;-;+15550000008'
  const replyRun = { id: 'run-1', replyTo: { channel: 'imessage', chatGuid: CHAT, messageGuid: 'm1' } }
  function fakeClient(opts: { failTyping?: boolean } = {}) {
    const calls: string[] = []
    const client = {
      markRead: vi.fn(async (c: string) => { calls.push(`read ${c}`) }),
      typing: vi.fn(async (c: string, on: boolean) => {
        if (opts.failTyping) throw new Error('typing broke')
        calls.push(`typing ${on} ${c}`)
      })
    }
    return { calls, deps: { client: async () => client as never, health: () => ({ privateApi: true as boolean | null }) } }
  }

  it('start marks the chat read and turns typing on; stop turns it off, in that order', async () => {
    const { calls, deps } = fakeClient()
    await channelPresence.start(replyRun, deps)
    await channelPresence.stop(replyRun, deps)
    expect(calls).toEqual([`read ${CHAT}`, `typing true ${CHAT}`, `typing false ${CHAT}`])
  })

  it('stop waits for a still-running start, so typing can never be left on', async () => {
    const { calls, deps } = fakeClient()
    const started = channelPresence.start(replyRun, deps) // not awaited
    await channelPresence.stop(replyRun, deps)
    await started
    expect(calls.at(-1)).toBe(`typing false ${CHAT}`)
  })

  it('does nothing for a run without replyTo', async () => {
    const { calls, deps } = fakeClient()
    await channelPresence.start({ id: 'run-2', replyTo: null }, deps)
    await channelPresence.stop({ id: 'run-2', replyTo: null }, deps)
    expect(calls).toEqual([])
  })

  it('does nothing when BlueBubbles reports the Private API off, but proceeds while it is unknown', async () => {
    const off = fakeClient()
    const offDeps = { ...off.deps, health: () => ({ privateApi: false as boolean | null }) }
    await channelPresence.start(replyRun, offDeps)
    await channelPresence.stop(replyRun, offDeps)
    expect(off.calls).toEqual([])

    const unknown = fakeClient()
    const unknownDeps = { ...unknown.deps, health: () => ({ privateApi: null as boolean | null }) }
    await channelPresence.start(replyRun, unknownDeps)
    expect(unknown.calls).toEqual([`read ${CHAT}`, `typing true ${CHAT}`])
    await channelPresence.stop(replyRun, unknownDeps)
  })

  it('does nothing without a client (iMessage not configured)', async () => {
    await expect(channelPresence.start(replyRun, { client: async () => null, health: () => ({ privateApi: true }) })).resolves.toBeUndefined()
    await expect(channelPresence.stop(replyRun, { client: async () => null, health: () => ({ privateApi: true }) })).resolves.toBeUndefined()
  })

  it('logs client failures and never rejects', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps } = fakeClient({ failTyping: true })
    await expect(channelPresence.start(replyRun, deps)).resolves.toBeUndefined()
    await expect(channelPresence.stop(replyRun, deps)).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
