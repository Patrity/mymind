// Cycle 81 Task 2 — the worker's lifecycle with every side effect faked (no DB): boot order, the
// tick/schedule/recorder start, the `kick` command and SIGTERM drain. (Task 3 removed AGENT_EXECUTOR
// and its web-executes idle mode: this worker is the only executor.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandHandlers } from '@mymind/core/lib/bus/commands'
import type { WorkstreamDTO } from '@mymind/core/shared/types/workstreams'
import { commandHandlers, crashSpan, createWorkerProcess, installCrashTraps, runWorker, type CrashEvent, type SignalName, type WorkerDeps, type WorkerTimings } from './worker'
import { workerSettings } from './env'

const T = { tickMs: 5_000, beatMs: 5_000, drainMs: 60_000 }
const quiet = { info: () => {}, warn: () => {}, error: () => {} }

function fakeDeps(over: Partial<WorkerDeps> = {}) {
  const calls: string[] = []
  let handlers: CommandHandlers | null = null
  // In-flight fake runs: waitForInFlight resolves once all of them have settled (or the deadline).
  const inFlight = new Set<Promise<void>>()
  let claimingStopped = false
  const deps: WorkerDeps = {
    boot: vi.fn(async (_stopped: () => boolean) => { calls.push('boot') }),
    tick: vi.fn(async () => { calls.push('tick') }),
    kick: vi.fn(() => { calls.push(claimingStopped ? 'kick:ignored' : 'kick') }),
    abort: vi.fn(async () => ({ settled: true })),
    imessageHealth: vi.fn(async (action: 'check' | 'reset') => { calls.push(`imessage:${action}`); return { ok: true, privateApi: true, checkedAt: 7 } }),
    approvalDecision: vi.fn(() => true),
    undo: vi.fn(async () => ({ ok: true })),
    presence: vi.fn(),
    invalidate: vi.fn(),
    workstreamControl: vi.fn(async (p: { workstreamId: string }) => ({ id: p.workstreamId, state: 'cancelled' }) as unknown as WorkstreamDTO),
    workspaceReenableNetwork: vi.fn(async (p: { workspaceId: string }) => ({ id: p.workspaceId, tainted: false })),
    workspaceReadText: vi.fn(async (p: { workspaceId: string; path: string }) => ({ content: 'hello', bytes: 5, path: `/workspace/${p.path}`, tainted: false })),
    startSchedule: vi.fn(() => { calls.push('schedule:start'); return () => { calls.push('schedule:stop') } }),
    startRecorderFlush: vi.fn(() => { calls.push('flush-loop:start'); return () => { calls.push('flush-loop:stop') } }),
    startSandbox: vi.fn(() => { calls.push('sandbox:start'); return () => { calls.push('sandbox:stop') } }),
    flushRecorder: vi.fn(async () => { calls.push('flush') }),
    beat: vi.fn(async () => { calls.push('beat') }),
    beatStatus: vi.fn(() => ({ imessage: { ok: true, privateApi: true, checkedAt: 7 } })),
    handleCommands: vi.fn((h: CommandHandlers) => { handlers = h; calls.push('commands:start'); return () => { calls.push('commands:stop') } }),
    startLiveBridge: vi.fn(() => { calls.push('bridge:start'); return () => { calls.push('bridge:stop') } }),
    stopClaiming: vi.fn(() => { claimingStopped = true; calls.push('stop-claiming') }),
    waitForInFlight: vi.fn(async (ms: number) => {
      calls.push('wait')
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = await Promise.race([
        Promise.all([...inFlight]).then(() => true),
        new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms) })
      ])
      clearTimeout(timer)
      calls.push(done ? 'settled' : 'deadline')
      return done
    }),
    prune: vi.fn(async () => { calls.push('prune') }),
    close: vi.fn(async () => { calls.push('close') }),
    log: quiet,
    ...over
  }
  /** A fake in-flight run; call the returned function to let it finish. */
  const startRun = () => {
    let finish!: () => void
    const p = new Promise<void>((r) => { finish = r }).then(() => { calls.push('run:settled') })
    inFlight.add(p)
    return finish
  }
  return { deps, calls, startRun, handlers: () => handlers! }
}

/** Start a worker (the old one-call shape the cases below use). */
async function startWorkerProcess(deps: WorkerDeps, t: WorkerTimings) {
  const w = createWorkerProcess(deps, t)
  await w.start()
  return w
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('worker boot', () => {
  it('beats, recovers orphans BEFORE anything can claim, then starts commands, bridge, pump, schedule, recorder flush', async () => {
    const { deps, calls } = fakeDeps()
    await startWorkerProcess(deps, T)
    expect(calls).toEqual(['beat', 'boot', 'commands:start', 'bridge:start', 'prune', 'kick', 'schedule:start', 'flush-loop:start', 'sandbox:start'])
  })

  it('ticks every tickMs and beats every beatMs; a slow tick is never overlapped', async () => {
    let release!: () => void
    const { deps, calls } = fakeDeps({ tick: vi.fn(() => new Promise<void>((r) => { release = () => { calls.push('tick:done'); r() } })) })
    await startWorkerProcess(deps, { ...T, beatMs: 2_000 })
    calls.length = 0
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000) // tick still in flight: skipped
    expect(deps.tick).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.tick).toHaveBeenCalledTimes(2)
    expect(calls.filter(c => c === 'beat')).toHaveLength(7) // 15s / 2s
  })

  it('a `kick` command pumps immediately (no wait for the next tick) and returns at once', async () => {
    const { deps, handlers } = fakeDeps()
    await startWorkerProcess(deps, T)
    vi.mocked(deps.kick).mockClear()
    await handlers().kick({ conversationId: 'c1' })
    expect(deps.kick).toHaveBeenCalledTimes(1)
    expect(deps.tick).not.toHaveBeenCalled()
  })

  it('M7: handled commands are pruned once at start and then every pruneMs, and the timer stops on drain', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = fakeDeps()
      const w = createWorkerProcess(deps, { ...T, pruneMs: 1_000 })
      await w.start()
      expect(deps.prune).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(deps.prune).toHaveBeenCalledTimes(3)
      await w.drain()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(deps.prune).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })

  // Cycle 81 Task 5: every command type is now owned; workstream-control returns the new state and
  // rejects a malformed payload rather than acting on it.
  it('workstream-control reaches controlWorkstream with its payload; a bad payload is refused', async () => {
    const { deps } = fakeDeps()
    const h = commandHandlers(deps)
    const p = { workstreamId: 'w1', action: 'steer' as const, text: 'look at X' }
    expect(await h['workstream-control'](p)).toMatchObject({ id: 'w1', state: 'cancelled' })
    expect(deps.workstreamControl).toHaveBeenCalledWith(p)
    await expect(h['workstream-control']({ workstreamId: 'w1', action: 'explode' } as never)).rejects.toThrow(/bad payload/)
    expect(deps.workstreamControl).toHaveBeenCalledTimes(1)
    await expect(h.abort({ runId: 'r1' })).resolves.toEqual({ settled: true })
  })

  it('workspace-reenable-network reaches the sandbox manager; a bad payload is refused', async () => {
    const { deps } = fakeDeps()
    const h = commandHandlers(deps)
    const id = '11111111-1111-4111-8111-111111111111'
    expect(await h['workspace-reenable-network']({ workspaceId: id })).toEqual({ id, tainted: false })
    expect(deps.workspaceReenableNetwork).toHaveBeenCalledWith({ workspaceId: id })
    await expect(h['workspace-reenable-network']({ workspaceId: '../x' })).rejects.toThrow(/bad payload/)
    expect(deps.workspaceReenableNetwork).toHaveBeenCalledTimes(1)
  })

  it('workspace-read-text (cycle 82 Task 2: a replayed export reads in the sandbox) validates its payload', async () => {
    const { deps } = fakeDeps()
    const h = commandHandlers(deps)
    const id = '11111111-1111-4111-8111-111111111111'
    expect(await h['workspace-read-text']({ workspaceId: id, path: 'out/report.md' })).toEqual({ content: 'hello', bytes: 5, path: '/workspace/out/report.md', tainted: false })
    expect(deps.workspaceReadText).toHaveBeenCalledWith({ workspaceId: id, path: 'out/report.md' })
    await expect(h['workspace-read-text']({ workspaceId: '../x', path: 'a' })).rejects.toThrow(/bad payload/)
    await expect(h['workspace-read-text']({ workspaceId: id, path: '' })).rejects.toThrow(/bad payload/)
    expect(deps.workspaceReadText).toHaveBeenCalledTimes(1)
  })

  // Cycle 81 Task 4: each command reaches its dependency with the payload's fields, and returns the
  // dependency's real answer (an undo's UndoResult, whether an approval was still pending).
  it('approval-decision, undo, presence and invalidate reach their dependencies', async () => {
    const { deps } = fakeDeps({ undo: vi.fn(async () => ({ ok: false, reason: 'undo expired or already used' })), approvalDecision: vi.fn(() => false) })
    const h = commandHandlers(deps)
    const d = { requestId: 'q1', approved: true, remember: true, pattern: 'git *' }
    expect(await h['approval-decision'](d)).toBe(false)
    expect(deps.approvalDecision).toHaveBeenCalledWith(d)
    expect(await h.undo({ token: 'tok' })).toEqual({ ok: false, reason: 'undo expired or already used' })
    expect(deps.undo).toHaveBeenCalledWith('tok')
    await h.presence({ lastActiveAt: 1234 })
    expect(deps.presence).toHaveBeenCalledWith(1234)
    await expect(h.presence({ lastActiveAt: Number.NaN })).rejects.toThrow(/timestamp/)
    await h.invalidate({ cache: 'ai-registry' })
    expect(deps.invalidate).toHaveBeenCalledWith('ai-registry')
  })
})

describe('worker-owned iMessage health (review M2)', () => {
  it('heartbeats carry the worker\'s iMessage health; the imessage-health command runs here', async () => {
    const { deps, handlers } = fakeDeps()
    await startWorkerProcess(deps, T)
    expect(deps.beat).toHaveBeenCalledWith({ imessage: { ok: true, privateApi: true, checkedAt: 7 } })
    expect(await handlers()['imessage-health']({ action: 'check' })).toEqual({ ok: true, privateApi: true, checkedAt: 7 })
    expect(deps.imessageHealth).toHaveBeenCalledWith('check')
  })
})

describe('signals during boot (review M4)', () => {
  it('runWorker installs SIGTERM/SIGINT handlers BEFORE anything starts', async () => {
    const { deps, calls } = fakeDeps()
    const handlers = new Map<SignalName, () => void>()
    const w = createWorkerProcess(deps, T)
    await runWorker(w, { on: (sig, fn) => { calls.push(`on:${sig}`); handlers.set(sig, fn) }, exit: () => {} })
    expect(calls.slice(0, 3)).toEqual(['on:SIGTERM', 'on:SIGINT', 'beat'])
  })

  it('a SIGTERM while boot is still recovering drains: nothing that claims ever starts, then exit 0', async () => {
    let releaseBoot!: () => void
    const { deps, calls } = fakeDeps({ boot: vi.fn(() => new Promise<void>((r) => { releaseBoot = () => { calls.push('boot'); r() } })) })
    const handlers = new Map<SignalName, () => void>()
    const exits: number[] = []
    const w = createWorkerProcess(deps, T)
    const running = runWorker(w, { on: (sig, fn) => { handlers.set(sig, fn) }, exit: c => { exits.push(c) } })
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.boot).toHaveBeenCalledTimes(1)
    handlers.get('SIGTERM')!()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(deps.boot).mock.calls[0]![0]()).toBe(true) // boot sees `stopped` (stops its retries)
    releaseBoot()
    await running
    await vi.advanceTimersByTimeAsync(0)
    expect(exits).toEqual([0])
    for (const c of ['commands:start', 'bridge:start', 'kick', 'schedule:start', 'flush-loop:start', 'sandbox:start']) expect(calls).not.toContain(c)
    expect(calls).toContain('stop-claiming')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deps.tick).not.toHaveBeenCalled()
  })
})

describe('worker drain (SIGTERM)', () => {
  it('a hung tick cannot push teardown past the drain budget (review M5)', async () => {
    const { deps, calls } = fakeDeps({ tick: vi.fn(() => new Promise<void>(() => {})) })
    const w = await startWorkerProcess(deps, { ...T, drainMs: 20_000 })
    await vi.advanceTimersByTimeAsync(5_000) // a tick starts and hangs forever
    expect(deps.tick).toHaveBeenCalledTimes(1)
    const drained = w.drain('SIGTERM')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await drained).toEqual({ settled: false })
    expect(calls.slice(-2)).toEqual(['flush', 'close'])
    // The tick wait and the runs wait share the ONE budget: the runs got what was left (0ms).
    expect(vi.mocked(deps.waitForInFlight).mock.calls[0]![0]).toBeLessThanOrEqual(0)
  })

  it('stops claiming first, resolves only after in-flight runs settle, then tears down', async () => {
    const { deps, calls, startRun, handlers } = fakeDeps()
    const w = await startWorkerProcess(deps, T)
    const finish = startRun()
    calls.length = 0
    const drained = w.drain('SIGTERM')
    let done = false
    void drained.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(done).toBe(false) // the run is still going
    expect(calls.slice(0, 3)).toEqual(['stop-claiming', 'schedule:stop', 'wait'])
    // No more ticks once draining; a kick arriving during the drain claims nothing.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.tick).not.toHaveBeenCalled()
    await handlers().kick({})
    expect(calls).toContain('kick:ignored')
    // Commands are still served mid-drain (a Stop must reach its run).
    expect(calls).not.toContain('commands:stop')
    finish()
    expect(await drained).toEqual({ settled: true })
    const tail = calls.slice(calls.indexOf('run:settled'))
    expect(tail).toEqual(['run:settled', 'settled', 'commands:stop', 'bridge:stop', 'flush-loop:stop', 'sandbox:stop', 'flush', 'close'])
    // Heartbeat stopped too.
    const beats = vi.mocked(deps.beat).mock.calls.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(vi.mocked(deps.beat).mock.calls.length).toBe(beats)
  })

  it('gives up at drainMs with runs still in flight (left for recovery) and still exits cleanly', async () => {
    const { deps, calls, startRun } = fakeDeps()
    const w = await startWorkerProcess(deps, { ...T, drainMs: 60_000 })
    startRun() // never finishes
    const drained = w.drain('SIGTERM')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await drained).toEqual({ settled: false })
    expect(calls).toContain('deadline')
    expect(calls.at(-1)).toBe('close')
  })

  it('a second signal shares the first drain', async () => {
    const { deps } = fakeDeps()
    const w = await startWorkerProcess(deps, T)
    const a = w.drain('SIGTERM')
    const b = w.drain('SIGINT')
    expect(b).toBe(a)
    await a
    expect(deps.stopClaiming).toHaveBeenCalledTimes(1)
  })
})

describe('workerSettings (env)', () => {
  it('maps CoreConfig through core\'s fromEnv (NUXT_ overrides, ns) with timing defaults', () => {
    const s = workerSettings({ DATABASE_URL: 'postgres://plain', NUXT_DATABASE_URL: 'postgres://nuxt', MYMIND_BUS_NS: 'w2' })
    expect(s.core.databaseUrl).toBe('postgres://nuxt')
    expect(s.core.busNs).toBe('w2')
    expect(s.core.dev).toBe(false)
    expect({ tickMs: s.tickMs, beatMs: s.beatMs, drainMs: s.drainMs }).toEqual({ tickMs: 5_000, beatMs: 5_000, drainMs: 60_000 })
  })
  it('unbundled, NODE_ENV=development is a dev host; timings are overridable', () => {
    const s = workerSettings({ NODE_ENV: 'development', WORKER_DRAIN_MS: '1500', WORKER_TICK_MS: 'nope' })
    expect(s.core.dev).toBe(true)
    expect(s.drainMs).toBe(1_500)
    expect(s.tickMs).toBe(5_000)
  })
})

describe('process crash traps (final review I1)', () => {
  function trap(deps: WorkerDeps, over: { crashDrainMs?: number } = {}) {
    const handlers = new Map<CrashEvent, (err: unknown) => void>()
    const exits: number[] = []
    const reports: Array<[CrashEvent, unknown]> = []
    const flush = vi.fn(async () => {})
    const w = createWorkerProcess(deps, T)
    installCrashTraps(w, { on: (e, fn) => { handlers.set(e, fn) }, exit: c => { exits.push(c) }, report: (e, err) => { reports.push([e, err]) }, flush, log: quiet, ...over })
    return { w, handlers, exits, reports, flush }
  }

  it('an unhandled rejection is logged + recorded and the worker keeps running (no drain, no exit)', async () => {
    const { deps, calls } = fakeDeps()
    const { w, handlers, exits, reports } = trap(deps)
    await w.start()
    handlers.get('unhandledRejection')!(new Error('stray'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(exits).toEqual([])
    expect(reports.map(r => r[0])).toEqual(['unhandledRejection'])
    expect(calls).not.toContain('stop-claiming')
    expect(deps.tick).toHaveBeenCalled()
  })

  it('a rejection storm records at most reportPerMinute rows', async () => {
    const { deps } = fakeDeps()
    const { handlers, reports } = trap(deps)
    for (let i = 0; i < 50; i++) handlers.get('unhandledRejection')!(new Error(`r${i}`))
    expect(reports).toHaveLength(20)
  })

  it('an uncaught exception records, drains, flushes, then exits 1', async () => {
    const { deps, calls } = fakeDeps()
    const { w, handlers, exits, reports, flush } = trap(deps)
    await w.start()
    handlers.get('uncaughtException')!(new Error('boom'))
    await vi.advanceTimersByTimeAsync(0)
    expect(reports.map(r => r[0])).toEqual(['uncaughtException'])
    expect(calls).toContain('stop-claiming')
    expect(exits).toEqual([1])
    expect(flush).toHaveBeenCalled()
  })

  it('the crash drain is bounded: a run that never settles still exits 1 at crashDrainMs', async () => {
    const { deps, startRun } = fakeDeps()
    startRun() // never finishes
    const { w, handlers, exits } = trap(deps, { crashDrainMs: 5_000 })
    await w.start()
    handlers.get('uncaughtException')!(new Error('boom'))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(exits).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(exits).toEqual([1])
  })

  it('a second uncaught exception during the drain exits at once', async () => {
    const { deps, startRun } = fakeDeps()
    startRun()
    const { w, handlers, exits } = trap(deps)
    await w.start()
    handlers.get('uncaughtException')!(new Error('one'))
    handlers.get('uncaughtException')!(new Error('two'))
    expect(exits).toEqual([1])
  })

  it('crashSpan is an error-severity job row carrying the message', () => {
    expect(crashSpan('uncaughtException', new Error('x'))).toMatchObject({ kind: 'job', name: 'worker:uncaughtException', status: 'error', severity: 'error', error: { message: 'x' } })
    expect(crashSpan('unhandledRejection', 'plain').error.message).toBe('plain')
  })
})
