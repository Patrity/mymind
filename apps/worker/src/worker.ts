// The worker process's lifecycle, with every side effect injected (main.ts wires the real ones;
// worker.test.ts fakes them). Spec §2:
//   boot  → recoverOrphans (+ seed jobs) → command handling + live bridge → 5s tick + immediate pump
//           → agent scheduled tasks → recorder flush; heartbeat every beatMs throughout.
//   drain → (SIGTERM) stop claiming + stop the tick and schedule → let in-flight runs finish
//           (≤ drainMs) → stop commands/bridge/heartbeat → flush → resolve. A run still going at
//           the deadline keeps its 'running' row and is recovered as interrupted by the next boot
//           (AGENT_RUNTIME_EXCLUSIVE) or the 60s stale sweep — the existing recovery semantics.
// With AGENT_EXECUTOR=web (Task 2's default, until Task 3) the worker only heartbeats: the web
// executes, and two executors on one database must never both claim.
import type { CommandHandlers, CommandPayloads } from '@mymind/core/lib/bus/commands'

export interface WorkerDeps {
  executor: 'web' | 'worker'
  /** recoverOrphans (+ seed jobs install/upgrade, revalidation) — bootAgentRuntime. */
  boot(): Promise<unknown>
  /** One runtime tick (workerTick). */
  tick(): Promise<unknown>
  /** Pump now (kickPump) — returns at once. */
  kick(): void
  abort(p: CommandPayloads['abort']): Promise<{ settled: boolean }>
  startSchedule(): () => void
  startRecorderFlush(): () => void
  flushRecorder(): Promise<void>
  beat(): Promise<void>
  handleCommands(h: CommandHandlers): () => void
  startLiveBridge(): () => void
  stopClaiming(): void
  waitForInFlight(timeoutMs: number): Promise<boolean>
  /** Last: close the listener / flush live NOTIFYs. */
  close(): Promise<void>
  log?: Pick<Console, 'info' | 'warn' | 'error'>
}

export interface WorkerTimings { tickMs: number; beatMs: number; drainMs: number }

export interface RunningWorker {
  /** Drain and stop. Idempotent: a second signal gets the same promise. */
  drain(reason?: string): Promise<{ settled: boolean }>
}

/** Handlers for every command type. Each returns once its action has started (bus contract). */
export function commandHandlers(deps: Pick<WorkerDeps, 'kick' | 'abort'>): CommandHandlers {
  const later = (type: string) => async () => { throw new Error(`the agent worker does not handle "${type}" yet (cycle 81 Task 4/5)`) }
  return {
    kick: async () => { deps.kick() },
    abort: async p => deps.abort(p),
    'approval-decision': later('approval-decision'),
    undo: later('undo'),
    presence: later('presence'),
    invalidate: later('invalidate'),
    'workstream-control': later('workstream-control')
  }
}

export async function startWorkerProcess(deps: WorkerDeps, t: WorkerTimings): Promise<RunningWorker> {
  const log = deps.log ?? console
  const stops: Array<() => void> = []
  const beatOnce = () => deps.beat().catch(err => log.error('[worker] heartbeat failed:', err))
  await beatOnce()
  const beatTimer = setInterval(() => { void beatOnce() }, t.beatMs)

  let tickTimer: ReturnType<typeof setInterval> | null = null
  let stopSchedule: (() => void) | null = null
  let tickInFlight: Promise<unknown> | null = null
  if (deps.executor === 'worker') {
    await deps.boot()
    stops.push(deps.handleCommands(commandHandlers(deps)))
    stops.push(deps.startLiveBridge())
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
    log.info('[worker] executing agent runs (AGENT_EXECUTOR=worker)')
  } else {
    log.info('[worker] AGENT_EXECUTOR=web — the web process executes agent runs; this worker only heartbeats')
  }

  let draining: Promise<{ settled: boolean }> | null = null
  const drain = (reason = 'stop'): Promise<{ settled: boolean }> => draining ??= (async () => {
    log.info(`[worker] draining (${reason})`)
    // 1. Never claim again; no more ticks or scheduled tasks. Commands keep flowing (a Stop during
    //    the drain must still abort its run); `kick` is a no-op once claiming has stopped.
    deps.stopClaiming()
    if (tickTimer) clearInterval(tickTimer)
    stopSchedule?.()
    // 2. Let what is running finish: a tick mid-flight (its jobs/outbox step), then the runs.
    await tickInFlight
    const settled = deps.executor === 'worker' ? await deps.waitForInFlight(t.drainMs) : true
    if (!settled) log.warn(`[worker] drain deadline (${t.drainMs}ms) passed with runs still in flight — they will be recovered as interrupted`)
    // 3. Tear down.
    for (const stop of stops.splice(0)) {
      try { stop() } catch (err) { log.error('[worker] stop failed:', err) }
    }
    clearInterval(beatTimer)
    await deps.flushRecorder().catch(err => log.error('[worker] recorder flush failed:', err))
    await deps.close().catch(err => log.error('[worker] close failed:', err))
    log.info(`[worker] drained (${settled ? 'all runs settled' : 'deadline hit'})`)
    return { settled }
  })()

  return { drain }
}
