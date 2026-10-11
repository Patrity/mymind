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
}

console.info(`[worker] boot ${BOOT_ID} pid=${process.pid} ns=${busNs()} dev=${settings.core.dev}`)

const worker = createWorkerProcess({
  boot: stopped => bootAgentRuntime(undefined, { ...DEFAULT_BOOT_RETRY, stopped }),
  tick: () => queue.workerTick(),
  kick: () => queue.kickPump(),
  // abort, approval-decision, undo, presence, invalidate, imessage-health (command-deps.ts).
  ...await coreCommandDeps(),
  startSchedule: () => startAgentSchedule(),
  startRecorderFlush: () => { record.startRecorderFlushLoop(); return () => {} },
  flushRecorder: () => record.recorder.flush(),
  beat: status => commands.beatWorker(BOOT_ID, status),
  // Worker-owned state the web shows: the iMessage catch-up health (Settings → Channels nav dot).
  beatStatus: () => ({ imessage: inbound.lastHealth() }),
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
