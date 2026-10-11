// MyMind agent worker — entry point (cycle 81, spec §2). Runs on @mymind/core with no Nuxt/Nitro.
//   dev:  `pnpm dev` (root) runs it under `tsx watch` next to `nuxt dev`
//   prod: `node apps/worker/dist/worker.mjs` (esbuild bundle, build.mjs) under systemd unit
//         `mymind-worker` (deploy/mymind-worker.service), env from /opt/mymind/.env + .env.native.
// SIGTERM/SIGINT drain (worker.ts) then exit 0; systemd's TimeoutStopSec covers the 60s drain.
import { initCore } from '@mymind/core/config'
import { workerSettings } from './env'
import { createWorkerProcess, runWorker } from './worker'

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

console.info(`[worker] boot ${BOOT_ID} pid=${process.pid} ns=${busNs()} executor=${settings.core.agentExecutor} dev=${settings.core.dev}`)

const worker = createWorkerProcess({
  executor: settings.core.agentExecutor,
  boot: stopped => bootAgentRuntime(undefined, { ...DEFAULT_BOOT_RETRY, stopped }),
  tick: () => queue.workerTick(),
  kick: () => queue.kickPump(),
  abort: async (p) => {
    if (p.runId) return queue.abortRunAndWait(p.runId)
    if (p.conversationId) { await queue.abortActiveAndWait(p.conversationId); return { settled: true } }
    return { settled: true }
  },
  imessageHealth: async (action) => {
    if (action === 'reset') inbound.resetHealth()
    else await inbound.catchUpTick({ force: true })
    return inbound.lastHealth()
  },
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
  close: async () => { await live.flushLive(); await listen.closeListener() }
}, settings)

// Signal handlers go in BEFORE anything starts (runWorker), so a SIGTERM during boot drains.
await runWorker(worker, { on: (sig, fn) => { process.on(sig, fn) }, exit: code => process.exit(code) })
