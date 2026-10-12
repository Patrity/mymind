// Cycle 81 Task 2 review M7: boot recovery retries (bounded backoff) until the DB answers, instead of
// failing once and losing the exclusive takeover. Steps are injected — no DB.
import { describe, expect, it, vi } from 'vitest'
import { bootAgentRuntime, type BootSteps } from './boot'

function steps(over: Partial<BootSteps> = {}): BootSteps {
  return {
    recoverOrphans: vi.fn(async () => 0),
    installSeedJobs: vi.fn(async () => 0),
    upgradeSeedJobs: vi.fn(async () => 0),
    revalidateAll: vi.fn(async () => 0),
    ...over
  }
}
const quiet = () => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}) }

describe('bootAgentRuntime recovery retry', () => {
  it('retries a failing recovery with growing, capped delays until the DB answers', async () => {
    quiet()
    let calls = 0
    const s = steps({ recoverOrphans: vi.fn(async () => { if (++calls < 4) throw new Error('ECONNREFUSED'); return 2 }) })
    const slept: number[] = []
    const r = await bootAgentRuntime(s, { maxMs: 60_000, baseMs: 100, maxDelayMs: 300, sleep: async (ms) => { slept.push(ms) } })
    expect(r).toEqual({ recovered: 2 })
    expect(s.recoverOrphans).toHaveBeenCalledTimes(4)
    expect(slept).toEqual([100, 200, 300])
    expect(s.installSeedJobs).toHaveBeenCalledTimes(1) // the rest of boot still runs, after recovery
    vi.restoreAllMocks()
  })

  it('gives up after maxMs and still finishes boot (the stale sweep is the net)', async () => {
    quiet()
    const s = steps({ recoverOrphans: vi.fn(async () => { throw new Error('down') }) })
    const r = await bootAgentRuntime(s, { maxMs: 30, baseMs: 10, maxDelayMs: 10 })
    expect(r).toEqual({ recovered: 0 })
    expect(vi.mocked(s.recoverOrphans).mock.calls.length).toBeGreaterThan(1)
    expect(s.revalidateAll).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('M2: closes verdicts left undecided by a crashed worker with THIS boot\'s start time; a failure there does not stop boot', async () => {
    quiet()
    const before = Date.now()
    const s = steps({ closeLostVerdicts: vi.fn(async () => { throw new Error('db hiccup') }) })
    await bootAgentRuntime(s, { maxMs: 1000, baseMs: 10, maxDelayMs: 10 })
    const at = vi.mocked(s.closeLostVerdicts!).mock.calls[0]![0]
    expect(at.getTime()).toBeGreaterThanOrEqual(before)
    expect(at.getTime()).toBeLessThanOrEqual(Date.now())
    expect(s.revalidateAll).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('stops retrying (and skips the rest of boot) once a drain started', async () => {
    quiet()
    let stopped = false
    const s = steps({ recoverOrphans: vi.fn(async () => { stopped = true; throw new Error('down') }), closeLostVerdicts: vi.fn(async () => 0) })
    await bootAgentRuntime(s, { maxMs: 60_000, baseMs: 10, maxDelayMs: 10, stopped: () => stopped })
    expect(s.recoverOrphans).toHaveBeenCalledTimes(1)
    expect(s.installSeedJobs).not.toHaveBeenCalled()
    expect(s.closeLostVerdicts).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
