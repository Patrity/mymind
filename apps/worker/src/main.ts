// MyMind agent worker — entry point (cycle 81, spec §2). Runs on @mymind/core with no Nuxt/Nitro.
//   dev:  `pnpm dev` (root) runs it under `tsx watch` next to `nuxt dev`
//   prod: `node apps/worker/dist/worker.mjs` (esbuild bundle, build.mjs) under systemd unit
//         `mymind-worker` (deploy/mymind-worker.service), env from /opt/mymind/.env + .env.native.
// SIGTERM/SIGINT drain (worker.ts) then exit 0; systemd's TimeoutStopSec covers the 60s drain.
import { initCore } from '@mymind/core/config'
import { workerSettings } from './env'
import { startWorkerProcess } from './worker'

const settings = workerSettings()
initCore(settings.core)

// Imported after initCore on purpose (dynamic): nothing below may touch the DB at module load
// before core has its config.
const [{ bootAgentRuntime }, queue, { BOOT_ID }, { startAgentSchedule }, record, commands, live, listen] = await Promise.all([
  import('@mymind/core/lib/agent/runtime/boot'),
  import('@mymind/core/lib/agent/runtime/queue'),
  import('@mymind/core/lib/agent/runtime/runs'),
  import('@mymind/core/lib/agent/scheduled'),
  import('@mymind/core/lib/observability/record'),
  import('@mymind/core/lib/bus/commands'),
  import('@mymind/core/lib/bus/live'),
  import('@mymind/core/lib/bus/listen')
])
const { busNs } = await import('@mymind/core/lib/bus/ns')

console.info(`[worker] boot ${BOOT_ID} pid=${process.pid} ns=${busNs()} executor=${settings.core.agentExecutor} dev=${settings.core.dev}`)

const worker = await startWorkerProcess({
  executor: settings.core.agentExecutor,
  boot: () => bootAgentRuntime(),
  tick: () => queue.workerTick(),
  kick: () => queue.kickPump(),
  abort: async (p) => {
    if (p.runId) return queue.abortRunAndWait(p.runId)
    if (p.conversationId) { await queue.abortActiveAndWait(p.conversationId); return { settled: true } }
    return { settled: true }
  },
  startSchedule: () => startAgentSchedule(),
  startRecorderFlush: () => { record.startRecorderFlushLoop(); return () => {} },
  flushRecorder: () => record.recorder.flush(),
  beat: () => commands.beatWorker(BOOT_ID),
  handleCommands: h => commands.handleCommands(h),
  startLiveBridge: () => live.startLiveBridge('worker'),
  stopClaiming: () => queue.stopClaiming(),
  waitForInFlight: ms => queue.waitForInFlight(ms),
  close: async () => { await live.flushLive(); await listen.closeListener() }
}, settings)

let signalled = false
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (signalled) return
    signalled = true
    void worker.drain(sig).then(
      () => process.exit(0),
      (err) => { console.error('[worker] drain failed:', err); process.exit(1) }
    )
  })
}
