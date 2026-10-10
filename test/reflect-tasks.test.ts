// test/reflect-tasks.test.ts
//
// Pure unit tests only (global-constraints.md: no real task body may run against the DB):
//   - shouldRunJobsPass (server/tasks/reflect-jobs.ts), including a DST-change day
//     (preflight Ruling 2, progress.md — overrides the plan's original "03:30 sharp" text).
//   - the mode short-circuit for both cron tasks: 'off' must never call the underlying pass.
//   - the reflect-jobs task's time gate, with useDb and getDefaultTimezone mocked so it never
//     touches the real DB, and the system clock faked so the gate is deterministic.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

vi.hoisted(() => { (globalThis as Record<string, unknown>).defineTask = (t: unknown) => t })

const m = vi.hoisted(() => ({
  mode: vi.fn(async () => 'on' as 'on' | 'review_only' | 'off'),
  runThreadPass: vi.fn(async () => ({ threads: 0, proposals: 0 })),
  runJobsPass: vi.fn(async () => ({ jobs: 0, proposals: 0 })),
  tz: vi.fn(async () => 'UTC')
}))
const dbState = vi.hoisted(() => ({ lastDateRow: null as { value: string } | null, inserted: [] as { key: string, value: string }[] }))

vi.mock('@mymind/core/lib/agent/self-improvement-mode', () => ({ getSelfImprovementMode: m.mode }))
vi.mock('@mymind/core/lib/agent/reflect/thread-pass', () => ({ runThreadPass: m.runThreadPass }))
vi.mock('@mymind/core/lib/agent/reflect/jobs-pass', () => ({ runJobsPass: m.runJobsPass }))
vi.mock('@mymind/core/lib/agent/jobs/timezone', () => ({ getDefaultTimezone: m.tz }))
vi.mock('@mymind/core/db', () => ({
  useDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (dbState.lastDateRow ? [dbState.lastDateRow] : []) }) }) }),
    insert: () => ({
      values: (v: { key: string, value: string }) => {
        dbState.inserted.push(v)
        return { onConflictDoUpdate: async () => {} }
      }
    })
  })
}))

import threadTask from '../server/tasks/reflect-threads'
import jobsTask, { shouldRunJobsPass } from '../server/tasks/reflect-jobs'

type TaskResult = { result: Record<string, unknown> }
const run = (t: unknown) => (t as { run: () => Promise<TaskResult> }).run()

afterEach(() => { vi.clearAllMocks(); dbState.lastDateRow = null; dbState.inserted = [] })

const CHICAGO = 'America/Chicago'

describe('shouldRunJobsPass (pure)', () => {
  it('03:40 local, not yet run today → true', () => {
    expect(shouldRunJobsPass(new Date('2027-01-15T09:40:00Z'), CHICAGO, '2027-01-14')).toBe(true)
  })
  it('02:40 local → false (before the 03:00 floor)', () => {
    expect(shouldRunJobsPass(new Date('2027-01-15T08:40:00Z'), CHICAGO, '2027-01-14')).toBe(false)
  })
  it('already ran today → false', () => {
    expect(shouldRunJobsPass(new Date('2027-01-15T09:40:00Z'), CHICAGO, '2027-01-15')).toBe(false)
  })
  it('05:40 local, not yet run today → true (a missed 03:40/04:40 tick still runs later the same day)', () => {
    expect(shouldRunJobsPass(new Date('2027-01-15T11:40:00Z'), CHICAGO, '2027-01-14')).toBe(true)
  })
  it('never run before (lastDate null) → true once past the floor', () => {
    expect(shouldRunJobsPass(new Date('2027-01-15T09:40:00Z'), CHICAGO, null)).toBe(true)
  })
  it('spring-forward DST day: the skipped 02:00-02:59 hour still gates correctly either side of the jump', () => {
    // 2027-03-14 America/Chicago: clocks jump 02:00 CST -> 03:00 CDT; the 2 o'clock hour never occurs.
    expect(shouldRunJobsPass(new Date('2027-03-14T07:40:00Z'), CHICAGO, '2027-03-13')).toBe(false) // 01:40 CST
    expect(shouldRunJobsPass(new Date('2027-03-14T08:40:00Z'), CHICAGO, '2027-03-13')).toBe(true) // 03:40 CDT
  })
  it('fall-back DST day: still fires once, at local 03:40', () => {
    // 2027-11-07 America/Chicago: clocks fall back 02:00 CDT -> 01:00 CST.
    expect(shouldRunJobsPass(new Date('2027-11-07T09:40:00Z'), CHICAGO, '2027-11-06')).toBe(true) // 03:40 CST
  })
})

describe('reflect-threads task — mode short-circuit', () => {
  it('off: never calls runThreadPass', async () => {
    m.mode.mockResolvedValueOnce('off')
    const out = await run(threadTask)
    expect(m.runThreadPass).not.toHaveBeenCalled()
    expect(out).toEqual({ result: { threads: 0, proposals: 0 } })
  })
  it('on: calls runThreadPass once and forwards its result', async () => {
    m.mode.mockResolvedValueOnce('on')
    m.runThreadPass.mockResolvedValueOnce({ threads: 2, proposals: 1 })
    const out = await run(threadTask)
    expect(m.runThreadPass).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ result: { threads: 2, proposals: 1 } })
  })
})

describe('reflect-jobs task — mode short-circuit', () => {
  it('off: never calls runJobsPass (and never touches the time gate)', async () => {
    m.mode.mockResolvedValueOnce('off')
    const out = await run(jobsTask)
    expect(m.runJobsPass).not.toHaveBeenCalled()
    expect(m.tz).not.toHaveBeenCalled()
    expect(out).toEqual({ result: { jobs: 0, proposals: 0 } })
  })
})

describe('reflect-jobs task — time gate (mode on)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('before the 03:00 floor: skips runJobsPass', async () => {
    vi.setSystemTime(new Date('2027-01-15T02:40:00Z')) // tz mocked to UTC
    m.mode.mockResolvedValueOnce('on')
    dbState.lastDateRow = null
    const out = await run(jobsTask)
    expect(m.runJobsPass).not.toHaveBeenCalled()
    expect(out).toEqual({ result: { jobs: 0, proposals: 0 } })
    expect(dbState.inserted).toEqual([])
  })

  it('past the floor and not yet run today: calls runJobsPass with `now`', async () => {
    const now = new Date('2027-01-15T03:40:00Z')
    vi.setSystemTime(now)
    m.mode.mockResolvedValueOnce('on')
    m.runJobsPass.mockResolvedValueOnce({ jobs: 3, proposals: 1 })
    dbState.lastDateRow = null
    const out = await run(jobsTask)
    expect(m.runJobsPass).toHaveBeenCalledTimes(1)
    expect(m.runJobsPass).toHaveBeenCalledWith({ now })
    expect(out).toEqual({ result: { jobs: 3, proposals: 1 } })
    // The run is marked done only after it completes, so a crash mid-pass would be retried later
    // the same day (see the comment in reflect-jobs.ts) — assert the persisted date, not just the call count.
    expect(dbState.inserted).toHaveLength(1)
    expect(dbState.inserted[0]).toMatchObject({ key: 'reflect_jobs_last_date', value: '2027-01-15' })
  })

  it('already ran today: skips runJobsPass', async () => {
    vi.setSystemTime(new Date('2027-01-15T04:40:00Z'))
    m.mode.mockResolvedValueOnce('on')
    dbState.lastDateRow = { value: '2027-01-15' }
    const out = await run(jobsTask)
    expect(m.runJobsPass).not.toHaveBeenCalled()
    expect(out).toEqual({ result: { jobs: 0, proposals: 0 } })
    expect(dbState.inserted).toEqual([])
  })

  it('runJobsPass throws: reflect_jobs_last_date is NOT written, and a later tick the same day still runs', async () => {
    // First tick: runJobsPass rejects mid-pass.
    vi.setSystemTime(new Date('2027-01-15T03:40:00Z'))
    m.mode.mockResolvedValueOnce('on')
    m.runJobsPass.mockRejectedValueOnce(new Error('boom'))
    dbState.lastDateRow = null
    await expect(run(jobsTask)).rejects.toThrow('boom')
    expect(dbState.inserted).toEqual([]) // never persisted — the crash happened before setLastDate

    // Second tick, later the SAME day: since nothing was persisted, the settings row a real
    // getLastDate() would see is still whatever it was before (unchanged by the failed run) —
    // here that's still null, so shouldRunJobsPass still gates true and the retry proceeds.
    vi.setSystemTime(new Date('2027-01-15T04:40:00Z'))
    m.mode.mockResolvedValueOnce('on')
    m.runJobsPass.mockResolvedValueOnce({ jobs: 1, proposals: 0 })
    const out = await run(jobsTask)
    expect(m.runJobsPass).toHaveBeenCalledTimes(2) // once rejected, once succeeded
    expect(out).toEqual({ result: { jobs: 1, proposals: 0 } })
    expect(dbState.inserted).toHaveLength(1)
    expect(dbState.inserted[0]).toMatchObject({ key: 'reflect_jobs_last_date', value: '2027-01-15' })
  })
})
