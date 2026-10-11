// The worker process's lifecycle, with every side effect injected (main.ts wires the real ones;
// worker.test.ts fakes them). Spec §2:
//   start → heartbeat → recoverOrphans (+ seed jobs; retried until the DB answers) → command
//           handling + live bridge → 5s tick + immediate pump → agent scheduled tasks → recorder
//           flush; heartbeat every beatMs throughout (carrying worker-only status, e.g. iMessage health).
//   drain → (SIGTERM) stop claiming + stop the tick and schedule → let the in-flight tick and runs
//           finish within ONE drainMs budget → stop commands/bridge/heartbeat → flush → resolve. A run
//           still going at the deadline keeps its 'running' row and is recovered as interrupted by
//           the next boot (AGENT_RUNTIME_EXCLUSIVE) or the 60s stale sweep — the existing semantics.
// A drain that arrives while `start` is still booting stops it between steps: nothing that claims
// (commands, tick, pump, schedule) starts after the signal (Task 2 review M4).
// This is the ONLY process that executes agent runs (cycle 81 Task 3): the web never claims.
import type { CommandHandlers, CommandPayloads, InvalidateCache, WorkerBeatStatus } from '@mymind/core/lib/bus/commands'
import type { ImessageHealth } from '@mymind/core/lib/channels/inbound'
import type { UndoResult } from '@mymind/core/lib/agent/undo'

export interface WorkerDeps {
  /** recoverOrphans (+ seed jobs install/upgrade, revalidation) — bootAgentRuntime. `stopped` lets
   *  its DB-retry loop give up when a drain arrives during boot. */
  boot(stopped: () => boolean): Promise<unknown>
  /** One runtime tick (workerTick). */
  tick(): Promise<unknown>
  /** Pump now (kickPump) — returns at once. */
  kick(): void
  abort(p: CommandPayloads['abort']): Promise<{ settled: boolean }>
  /** The iMessage catch-up health this process owns: `check` = forced catch-up, `reset` = forget. */
  imessageHealth(action: CommandPayloads['imessage-health']['action']): Promise<ImessageHealth>
  /** Resolve a pending card of a run executing here (runtime/bus-approvals.ts); false = none. */
  approvalDecision(p: CommandPayloads['approval-decision']): boolean
  /** Redeem an undo token minted here (undo.ts). */
  undo(token: string): Promise<UndoResult>
  /** Tony's last web activity (presence.ts markActive) — what isAway reads here. */
  presence(lastActiveAt: number): void
  /** Drop this process's copy of a settings cache (bus/invalidate.ts). */
  invalidate(cache: InvalidateCache): void
  startSchedule(): () => void
  startRecorderFlush(): () => void
  flushRecorder(): Promise<void>
  /** Heartbeat, carrying the worker-owned status the web shows. */
  beat(status?: WorkerBeatStatus): Promise<void>
  /** The status every heartbeat carries. */
  beatStatus(): WorkerBeatStatus
  handleCommands(h: CommandHandlers): () => void
  startLiveBridge(): () => void
  stopClaiming(): void
  waitForInFlight(timeoutMs: number): Promise<boolean>
  /** Last: close the listener / flush live NOTIFYs. */
  close(): Promise<void>
  log?: Pick<Console, 'info' | 'warn' | 'error'>
}

export interface WorkerTimings { tickMs: number; beatMs: number; drainMs: number }

export interface WorkerProcess {
  /** Boot and start everything. Resolves when started (or when a drain stopped the boot early). */
  start(): Promise<void>
  /** Drain and stop. Idempotent: a second signal gets the same promise. Safe before/while starting. */
  drain(reason?: string): Promise<{ settled: boolean }>
}

/** Handlers for every command type. Each returns once its action has started (bus contract). */
export type CommandDeps = Pick<WorkerDeps, 'kick' | 'abort' | 'imessageHealth' | 'approvalDecision' | 'undo' | 'presence' | 'invalidate'>
export function commandHandlers(deps: CommandDeps): CommandHandlers {
  const later = (type: string) => async () => { throw new Error(`the agent worker does not handle "${type}" yet (cycle 81 Task 5)`) }
  return {
    kick: async () => { deps.kick() },
    abort: async p => deps.abort(p),
    'imessage-health': async p => deps.imessageHealth(p.action),
    'approval-decision': async p => deps.approvalDecision(p),
    undo: async p => deps.undo(p.token),
    presence: async (p) => {
      if (!Number.isFinite(p.lastActiveAt)) throw new Error('presence: lastActiveAt must be a timestamp')
      deps.presence(p.lastActiveAt)
    },
    invalidate: async (p) => { deps.invalidate(p.cache) },
    'workstream-control': later('workstream-control')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, Math.max(0, ms)))
}

export function createWorkerProcess(deps: WorkerDeps, t: WorkerTimings): WorkerProcess {
  const log = deps.log ?? console
  const stops: Array<() => void> = []
  let beatTimer: ReturnType<typeof setInterval> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let stopSchedule: (() => void) | null = null
  let tickInFlight: Promise<unknown> | null = null
  let stopping = false
  let starting: Promise<void> | null = null
  let draining: Promise<{ settled: boolean }> | null = null

  const beatOnce = () => deps.beat(deps.beatStatus()).catch(err => log.error('[worker] heartbeat failed:', err))

  const start = (): Promise<void> => starting ??= (async () => {
    if (stopping) return
    await beatOnce()
    beatTimer = setInterval(() => { void beatOnce() }, t.beatMs)
    if (stopping) return
    await deps.boot(() => stopping)
    // Each step re-checks: a signal during boot must not start anything that claims.
    if (stopping) return
    stops.push(deps.handleCommands(commandHandlers(deps)))
    stops.push(deps.startLiveBridge())
    if (stopping) return
    let ticks = 0
    tickTimer = setInterval(() => {
      if (tickInFlight) return
      tickInFlight = deps.tick()
        .then(() => { if (++ticks === 1) log.info('[worker] first tick complete') })
        .catch(err => log.error('[worker] tick failed:', err))
        .finally(() => { tickInFlight = null })
    }, t.tickMs)
    deps.kick()
    stopSchedule = deps.startSchedule()
    stops.push(deps.startRecorderFlush())
    log.info('[worker] executing agent runs')
  })()

  const drain = (reason = 'stop'): Promise<{ settled: boolean }> => draining ??= (async () => {
    log.info(`[worker] draining (${reason})`)
    stopping = true
    const deadline = Date.now() + t.drainMs
    // 1. Never claim again; no more ticks or scheduled tasks. Commands keep flowing (a Stop during
    //    the drain must still abort its run); `kick` is a no-op once claiming has stopped.
    const haltTimers = () => {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
      if (stopSchedule) { stopSchedule(); stopSchedule = null }
    }
    deps.stopClaiming()
    haltTimers()
    // A boot in progress finishes its current step (it checks `stopping` between steps).
    if (starting) await Promise.race([starting.catch(() => {}), sleep(deadline - Date.now())])
    haltTimers() // in case a racing boot step started them after step 1
    // 2. Let what is running finish — the in-flight tick, then the runs — inside ONE budget, so a
    //    hung tick (BlueBubbles, DB) can't push the teardown past systemd's TimeoutStopSec (M5).
    let settled = true
    if (tickInFlight) {
      const done = await Promise.race([tickInFlight.then(() => true), sleep(deadline - Date.now()).then(() => false)])
      if (!done) { settled = false; log.warn('[worker] drain: the in-flight tick did not finish within the budget') }
    }
    settled = (await deps.waitForInFlight(Math.max(0, deadline - Date.now()))) && settled
    if (!settled) log.warn(`[worker] drain deadline (${t.drainMs}ms) passed with work still in flight — runs left 'running' are recovered as interrupted`)
    // 3. Tear down.
    for (const stop of stops.splice(0)) {
      try { stop() } catch (err) { log.error('[worker] stop failed:', err) }
    }
    if (beatTimer) clearInterval(beatTimer)
    await deps.flushRecorder().catch(err => log.error('[worker] recorder flush failed:', err))
    await deps.close().catch(err => log.error('[worker] close failed:', err))
    log.info(`[worker] drained (${settled ? 'all runs settled' : 'deadline hit'})`)
    return { settled }
  })()

  return { start, drain }
}

export type SignalName = 'SIGTERM' | 'SIGINT'

/**
 * The process wiring main.ts runs: install the SIGTERM/SIGINT handlers FIRST, then start — so a
 * signal at any point of boot drains instead of hitting Node's default immediate kill (M4).
 */
export async function runWorker(
  w: WorkerProcess,
  io: { on(sig: SignalName, fn: () => void): void; exit(code: number): void; log?: Pick<Console, 'error'> }
): Promise<void> {
  let signalled = false
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    io.on(sig, () => {
      if (signalled) return
      signalled = true
      void w.drain(sig).then(() => io.exit(0), (err) => { (io.log ?? console).error('[worker] drain failed:', err); io.exit(1) })
    })
  }
  await w.start()
}
