// MyMind agent worker — entry point (cycle 81, spec §2). Runs on @mymind/core with no Nuxt/Nitro.
//   dev:  `pnpm dev` (root) runs it under `tsx watch` next to `nuxt dev`
//   prod: `node /opt/mymind/.worker/dist/worker.mjs` — the staged release (build.mjs + stage.mjs,
//         activated by deploy/worker-release.sh) — under systemd unit `mymind-worker`
//         (deploy/mymind-worker.service), env from /opt/mymind/.env + .env.native.
// SIGTERM/SIGINT drain (worker.ts) then exit 0; systemd's TimeoutStopSec covers the 60s drain.
import { initCore } from '@mymind/core/config'
import { workerSettings } from './env'
import { createWorkerProcess, crashSpan, installCrashTraps, runWorker } from './worker'
import { coreCommandDeps } from './command-deps'

const settings = workerSettings()
initCore(settings.core)

// Imported after initCore on purpose (dynamic): nothing below may touch the DB at module load
// before core has its config.
const [{ bootAgentRuntime, DEFAULT_BOOT_RETRY }, queue, { BOOT_ID }, { startAgentSchedule }, record, commands, live, listen, inbound] = await Promise.all([
  import('@mymind/core/lib/agent/runtime/boot'),
  import('@mymind/core/lib/agent/runtime/queue'),
  import('@mymind/core/lib/agent/runtime/runs'),
  import('@mymind/core/lib/agent/scheduled'),
  import('@mymind/core/lib/observability/record'),
  import('@mymind/core/lib/bus/commands'),
  import('@mymind/core/lib/bus/live'),
  import('@mymind/core/lib/bus/listen'),
  import('@mymind/core/lib/channels/inbound')
])
const { busNs } = await import('@mymind/core/lib/bus/ns')
const { pruneRunEvents } = await import('@mymind/core/lib/bus/events')
const { pruneVerdicts } = await import('@mymind/core/lib/agent/judge/store')
const { startSandboxHousekeeping } = await import('@mymind/core/lib/sandbox/manager')
const { startWorkspaceRuntime } = await import('@mymind/core/lib/sandbox/runtime')
const { workstreamNotifyDeps } = await import('@mymind/core/lib/agent/workstreams/notify')

// Hourly: handled / long-dead claimed commands. Daily (spec §3.1): run_events of runs finished
// > 7 days ago, a workstream's kept while it exists.
const DAY_MS = 24 * 60 * 60 * 1000
let lastEventsPrune = 0
async function prune(): Promise<void> {
  await commands.pruneHandledCommands()
  if (Date.now() - lastEventsPrune < DAY_MS) return
  lastEventsPrune = Date.now()
  const n = await pruneRunEvents()
  if (n) console.info(`[worker] pruned ${n} run event(s)`)
  // Cycle 84 final fix wave (M2): the approval_verdicts audit keeps 180 days.
  const v = await pruneVerdicts()
  if (v) console.info(`[worker] pruned ${v} approval verdict(s) older than 180 days`)
}

let sandboxHealth: import('@mymind/core/shared/types/workspaces').SandboxHealth | null = null

console.info(`[worker] boot ${BOOT_ID} pid=${process.pid} ns=${busNs()} dev=${settings.core.dev}`)

const worker = createWorkerProcess({
  boot: async (stopped) => {
    const r = await bootAgentRuntime(undefined, { ...DEFAULT_BOOT_RETRY, stopped })
    // Cycle 85 (fix round 1, I2): eval tenants / sandboxes / dirs left by a crash or redeploy —
    // in the background (docker can be slow), never a live run's young world. Never throws.
    // Task 3: first an eval run a crash left 'running' is marked failed (partial results kept), so the
    // sweep drops its worlds; then the built-in suites (evals/*.json) are seeded.
    // Fix round 1 (I2): then every minute, the stale-heartbeat check (a run whose worker died elsewhere).
    void import('@mymind/core/lib/eval/runs').then(async (m) => { await m.bootEval(); m.startEvalHousekeeping() }).catch(err => console.warn('[eval] boot failed:', err))
    return r
  },
  tick: () => queue.workerTick(),
  kick: () => queue.kickPump(),
  // abort, approval-decision, undo, presence, invalidate, imessage-health (command-deps.ts).
  ...await coreCommandDeps(),
  startSchedule: () => startAgentSchedule(),
  startRecorderFlush: () => { record.startRecorderFlushLoop(); return () => {} },
  // Cycle 82: reconcile sandbox containers, then idle-stop / quota every minute, deletion sweep daily.
  // The 5s free-space watchdog records + texts Tony once per low-disk episode (review I2).
  // Task 2: the workspace runtime — manager hooks now; background shells re-attached and watches
  // re-armed once the container reconcile has run.
  // Final review M3: started BEFORE the worker handles commands or claims runs (worker.ts), so the
  // runtime hooks are in place for the very first workspace command. I6: the preflight result rides
  // on the heartbeat (beatStatus) — the web shows it, CD warns on it.
  startSandbox: () => {
    const rt = startWorkspaceRuntime()
    const stopHousekeeping = startSandboxHousekeeping(undefined, {
      afterReconcile: rt.afterReconcile,
      onTick: rt.onTick,
      onHealth: (h) => { sandboxHealth = h },
      onLowDisk: async (r) => {
        const gb = (r.freeBytes / 1024 ** 3).toFixed(1)
        const msg = `MyMind server low on disk: ${gb} GB free — stopped ${r.stopped.length} workspace sandbox(es); workspace commands are refused until space is freed.`
        record.recordEvent({ kind: 'job', name: 'sandbox:low-disk', status: 'error', severity: 'error', error: { message: msg }, meta: { freeBytes: r.freeBytes, stopped: r.stopped } })
        await workstreamNotifyDeps.text(msg, null).catch(err => console.error('[sandbox] low-disk text failed:', err))
      }
    })
    return () => { stopHousekeeping(); rt.stop() }
  },
  flushRecorder: () => record.recorder.flush(),
  beat: status => commands.beatWorker(BOOT_ID, status),
  // Worker-owned state the web shows: the iMessage catch-up health (Settings → Channels nav dot).
  beatStatus: () => ({ imessage: inbound.lastHealth(), ...(sandboxHealth ? { sandbox: sandboxHealth } : {}) }),
  handleCommands: h => commands.handleCommands(h),
  startLiveBridge: () => live.startLiveBridge('worker'),
  stopClaiming: () => queue.stopClaiming(),
  waitForInFlight: ms => queue.waitForInFlight(ms),
  // Handled commands older than a day (presence pings, decisions, aborts…) — fix round 1, M7.
  prune: () => prune(),
  close: async () => { await live.flushLive(); await listen.closeListener() }
}, settings)

// Process-level traps (final review I1): a stray rejection logs + records and the worker keeps
// going (Nitro parity); an uncaught exception records, drains (bounded), and exits 1 for systemd.
installCrashTraps(worker, {
  on: (event, fn) => { process.on(event, fn) },
  exit: code => process.exit(code),
  report: (event, err) => record.recordEvent(crashSpan(event, err)),
  flush: () => record.recorder.flush()
})

// Signal handlers go in BEFORE anything starts (runWorker), so a SIGTERM during boot drains.
await runWorker(worker, { on: (sig, fn) => { process.on(sig, fn) }, exit: code => process.exit(code) })
