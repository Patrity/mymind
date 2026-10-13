// Child process for bus.db.test.ts — the "worker" side, run under plain tsx (no vitest, no Nuxt),
// exactly as apps/worker will run core. Writes only what the parent test asks for.
//
//   tsx bus-child.ts commands        → handleCommands with echo handlers; prints READY
//   tsx bus-child.ts live <id>       → startLiveBridge('worker'), publishChange(task <id>) once;
//                                      prints SENT, then idles until killed
import { initCore } from '../../../config'
import { fromEnv } from '../../../config-env'
import { handleCommands } from '../commands'
import { listenReady } from '../listen'
import { flushLive, startLiveBridge } from '../live'
import { publishChange } from '../../../utils/live-bus'

// The worker's own mapper: MYMIND_BUS_NS (set by the parent test) reaches busNs() through it.
initCore(fromEnv(process.env))

const [mode, arg] = process.argv.slice(2)

if (mode === 'commands') {
  handleCommands({
    kick: async () => undefined,
    abort: async (p) => {
      if (p.conversationId?.startsWith('boom')) throw new Error(`boom from child ${process.pid}`)
      return { settled: true }
    },
    'approval-decision': async () => undefined,
    undo: async ({ token }) => ({ ok: true, reason: `undone:${token}:pid=${process.pid}` }),
    presence: async () => undefined,
    invalidate: async () => undefined,
    'workstream-control': async () => undefined,
    'workspace-read-text': async () => undefined,
    'workspace-view': async () => undefined,
    'workspace-kill-shell': async () => undefined,
    'imessage-health': async () => ({ ok: true, privateApi: null, checkedAt: null }),
    'eval:run-suite': async () => ({ started: false }),
    'eval:cancel': async () => ({ stopped: [] })
  }, { pollMs: 200 })
  await listenReady()
  console.log('READY')
} else if (mode === 'live') {
  startLiveBridge('worker')
  await listenReady()
  publishChange({ resource: 'task', action: 'updated', id: arg! })
  await flushLive()
  console.log('SENT')
} else {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}
// Keep the event loop alive until the parent kills us (the listener/poll timers are unref'd).
setInterval(() => {}, 1 << 30)
