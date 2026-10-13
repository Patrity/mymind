// The worker process's lifecycle, with every side effect injected (main.ts wires the real ones;
// worker.test.ts fakes them). Spec §2:
//   start → heartbeat → recoverOrphans (+ seed jobs; retried until the DB answers) → sandbox runtime
//           + housekeeping (cycle 82 — its hooks before anything can run a workspace command) →
//           command handling + live bridge → 5s tick + immediate pump → agent scheduled tasks →
//           recorder flush; heartbeat every beatMs throughout (carrying worker-only status, e.g.
//           iMessage health and the sandbox preflight).
//   drain → (SIGTERM) stop claiming + stop the tick and schedule → let the in-flight tick and runs
//           finish within ONE drainMs budget → stop commands/bridge/heartbeat → flush → resolve. A run
//           still going at the deadline keeps its 'running' row and is recovered as interrupted by
//           the next boot (AGENT_RUNTIME_EXCLUSIVE) or the 60s stale sweep — the existing semantics.
// A drain that arrives while `start` is still booting stops it between steps: nothing that claims
// (commands, tick, pump, schedule) starts after the signal (Task 2 review M4).
// This is the ONLY process that executes agent runs (cycle 81 Task 3): the web never claims.
import type { CommandHandlers, CommandPayloads, CommandResults, InvalidateCache, WorkerBeatStatus } from '@mymind/core/lib/bus/commands'
import { workspacePathProblem } from '@mymind/core/lib/sandbox/paths'
import type { ImessageHealth } from '@mymind/core/lib/channels/inbound'
import type { UndoResult } from '@mymind/core/lib/agent/undo'
import type { WorkstreamDTO } from '@mymind/core/shared/types/workstreams'

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
  /** Cancel / resume / steer a workstream (workstreams/loop.ts controlWorkstream) — its new state. */
  workstreamControl(p: CommandPayloads['workstream-control']): Promise<WorkstreamDTO>
  /** Cycle 82: kill a workspace's tainted runs, then clear its taint (lib/sandbox/manager.ts). */
  workspaceReenableNetwork(p: CommandPayloads['workspace-reenable-network']): Promise<{ id: string; tainted: boolean }>
  /** Cycle 82 Task 2: a workspace text file, read in the sandbox (export_to_document replayed in the web). */
  workspaceReadText(p: CommandPayloads['workspace-read-text']): Promise<CommandResults['workspace-read-text']>
  /** Cycle 82 Task 3: the Files / Shells UI's reads, run in the sandbox (lib/sandbox/view.ts). */
  workspaceView(p: CommandPayloads['workspace-view']): Promise<unknown>
  /** Cycle 82 Task 3: Tony's Kill on the Shells tab. */
  workspaceKillShell(p: CommandPayloads['workspace-kill-shell']): Promise<CommandResults['workspace-kill-shell']>
  /** Cycle 85: claim a queued eval run and start it in the background (lib/eval/runs.ts). */
  evalRun(p: CommandPayloads['eval:run-suite']): Promise<CommandResults['eval:run-suite']>
  startSchedule(): () => void
  startRecorderFlush(): () => void
  /** Cycle 82: sandbox housekeeping — boot reconcile, then idle-stop + quota every minute and the
   *  daily deletion sweep (lib/sandbox/manager.ts startSandboxHousekeeping). Never throws. */
  startSandbox(): () => void
  flushRecorder(): Promise<void>
  /** Heartbeat, carrying the worker-owned status the web shows. */
  beat(status?: WorkerBeatStatus): Promise<void>
  /** The status every heartbeat carries. */
  beatStatus(): WorkerBeatStatus
  handleCommands(h: CommandHandlers): () => void
  startLiveBridge(): () => void
  stopClaiming(): void
  waitForInFlight(timeoutMs: number): Promise<boolean>
  /** Periodic housekeeping (fix round 1, M7): prune handled (and long-dead claimed) worker_commands,
   *  and (cycle 81 Task 5) the daily run_events retention. Never throws into the loop. */
  prune(): Promise<unknown>
  /** Last: close the listener / flush live NOTIFYs. */
  close(): Promise<void>
  log?: Pick<Console, 'info' | 'warn' | 'error'>
}

export interface WorkerTimings { tickMs: number; beatMs: number; drainMs: number; /** default 1h */ pruneMs?: number }

export interface WorkerProcess {
  /** Boot and start everything. Resolves when started (or when a drain stopped the boot early). */
  start(): Promise<void>
  /** Drain and stop. Idempotent: a second signal gets the same promise. Safe before/while starting. */
  drain(reason?: string): Promise<{ settled: boolean }>
}

/** Handlers for every command type. Each returns once its action has started (bus contract). */
export type CommandDeps = Pick<WorkerDeps, 'kick' | 'abort' | 'imessageHealth' | 'approvalDecision' | 'undo' | 'presence' | 'invalidate' | 'workstreamControl' | 'workspaceReenableNetwork' | 'workspaceReadText' | 'workspaceView' | 'workspaceKillShell' | 'evalRun'>
export function commandHandlers(deps: CommandDeps): CommandHandlers {
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
    'workstream-control': async (p) => {
      if (!p || typeof p.workstreamId !== 'string' || !['cancel', 'resume', 'steer'].includes(p.action)) throw new Error('workstream-control: bad payload')
      return deps.workstreamControl(p)
    },
    'workspace-reenable-network': async (p) => {
      if (!p || typeof p.workspaceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(p.workspaceId)) throw new Error('workspace-reenable-network: bad payload')
      return deps.workspaceReenableNetwork(p)
    },
    'workspace-read-text': async (p) => {
      if (!p || typeof p.workspaceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(p.workspaceId) || typeof p.path !== 'string' || !p.path || p.path.length > 4096 || (p.tainted !== undefined && typeof p.tainted !== 'boolean') || (p.offline !== undefined && typeof p.offline !== 'boolean')) throw new Error('workspace-read-text: bad payload')
      return deps.workspaceReadText(p)
    },
    'workspace-view': async (p) => {
      if (!p || !isUuid(p.workspaceId) || (p.noStart !== undefined && typeof p.noStart !== 'boolean')) throw new Error('workspace-view: bad payload')
      const noStart = p.noStart === true ? { noStart: true } : {}
      switch (p.op) {
        case 'tree': return deps.workspaceView({ op: 'tree', workspaceId: p.workspaceId, ...noStart })
        case 'file':
          if (workspacePathProblem(p.path)) throw new Error('workspace-view: bad payload')
          return deps.workspaceView({ op: 'file', workspaceId: p.workspaceId, path: p.path, ...noStart })
        case 'chunk':
          if (workspacePathProblem(p.path) || !Number.isSafeInteger(p.offset) || p.offset < 0 || !Number.isSafeInteger(p.length) || p.length < 0) throw new Error('workspace-view: bad payload')
          return deps.workspaceView({ op: 'chunk', workspaceId: p.workspaceId, path: p.path, offset: p.offset, length: p.length, ...noStart })
        case 'shell-tail':
          if (!isUuid(p.shellId)) throw new Error('workspace-view: bad payload')
          return deps.workspaceView({ op: 'shell-tail', workspaceId: p.workspaceId, shellId: p.shellId, ...noStart })
        default: throw new Error('workspace-view: bad payload')
      }
    },
    'workspace-kill-shell': async (p) => {
      if (!p || !isUuid(p.workspaceId) || !isUuid(p.shellId)) throw new Error('workspace-kill-shell: bad payload')
      return deps.workspaceKillShell({ workspaceId: p.workspaceId, shellId: p.shellId })
    },
    'eval:run-suite': async (p) => {
      if (!p || !isUuid(p.runId)) throw new Error('eval:run-suite: bad payload')
      return deps.evalRun({ runId: p.runId })
    }
  }
}

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

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
    // Cycle 82 final review M3: the sandbox runtime (its manager hooks) before anything that can run
    // a workspace command — a command handler, a claimed run.
    stops.push(deps.startSandbox())
    stops.push(deps.handleCommands(commandHandlers(deps)))
    stops.push(deps.startLiveBridge())
    const prune = () => { deps.prune().catch(err => log.error('[worker] prune failed:', err)) }
    prune()
    const pruneTimer = setInterval(prune, t.pruneMs ?? 60 * 60 * 1000)
    pruneTimer.unref?.()
    stops.push(() => clearInterval(pruneTimer))
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

export type CrashEvent = 'unhandledRejection' | 'uncaughtException'

export interface CrashTrapIo {
  on(event: CrashEvent, fn: (err: unknown) => void): void
  exit(code: number): void
  /** Record to activity_log (recorder.recordEvent). Must not throw; a throw is swallowed. */
  report(event: CrashEvent, err: unknown): void
  /** Flush the recorder before exiting, so the crash row lands. */
  flush(): Promise<void>
  /** Bounded drain after an uncaughtException (default 15s, well inside TimeoutStopSec). */
  crashDrainMs?: number
  /** Max activity rows per minute (a rejection storm must not flood activity_log). Default 20. */
  reportPerMinute?: number
  log?: Pick<Console, 'error'>
  now?: () => number
}

/**
 * Process-level error traps (final review I1). Under Nitro both events were trapped and only logged;
 * the bare Node worker would otherwise die on the first stray rejection, interrupting every in-flight
 * run. Parity with Nitro for `unhandledRejection` (log + record, keep going). An `uncaughtException`
 * leaves the process in an unknown state, so: log + record, a BOUNDED drain (in-flight runs get a
 * chance to finish; what doesn't is recovered as interrupted by the next boot), flush, exit 1 so
 * systemd restarts it (the unit has StartLimitIntervalSec=0: a crash loop never parks it 'failed').
 * A second uncaughtException during that drain exits at once.
 */
export function installCrashTraps(w: WorkerProcess, io: CrashTrapIo): void {
  const log = io.log ?? console
  const now = io.now ?? Date.now
  const perMinute = io.reportPerMinute ?? 20
  let windowStart = 0
  let inWindow = 0
  const report = (event: CrashEvent, err: unknown) => {
    const t = now()
    if (t - windowStart >= 60_000) { windowStart = t; inWindow = 0 }
    if (++inWindow > perMinute) return
    try { io.report(event, err) } catch (e) { log.error('[worker] crash report failed:', e) }
  }
  io.on('unhandledRejection', (err) => {
    log.error('[worker] unhandled rejection (continuing):', err)
    report('unhandledRejection', err)
  })
  let crashing = false
  io.on('uncaughtException', (err) => {
    log.error('[worker] uncaught exception — draining, then exiting 1:', err)
    if (crashing) { io.exit(1); return }
    crashing = true
    report('uncaughtException', err)
    const ms = io.crashDrainMs ?? 15_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((r) => { timer = setTimeout(r, ms) })
    void Promise.race([w.drain('uncaughtException').then(() => {}, e => log.error('[worker] crash drain failed:', e)), deadline])
      .then(() => io.flush().catch(e => log.error('[worker] crash flush failed:', e)))
      .finally(() => { clearTimeout(timer); io.exit(1) })
  })
}

/** activity_log row for a trapped process error (what main.ts hands io.report). */
export function crashSpan(event: CrashEvent, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err))
  return {
    kind: 'job' as const,
    name: `worker:${event}`,
    status: 'error' as const,
    severity: 'error' as const,
    error: { message: e.message, stack: e.stack }
  }
}
