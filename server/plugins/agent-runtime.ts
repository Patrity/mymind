import { loadRuntimeFlag } from '../lib/agent/runtime/flag'
import { recoverOnBoot } from '../lib/agent/runtime/recover'
import { startWorker, stopWorker } from '../lib/agent/runtime/queue'

// Boot order: read the flag, recover runs orphaned by the previous process, then start the
// worker. Recovery before the worker so a stale 'running' row cannot block its conversation's
// queue for the 60s it would take to look orphaned.
export default defineNitroPlugin(async (nitro) => {
  if (import.meta.prerender) return
  try {
    if (!(await loadRuntimeFlag())) { console.info('[runtime] agent_runtime=false — legacy WS path'); return }
    const n = await recoverOnBoot()
    if (n) console.warn(`[runtime] recovered ${n} interrupted run(s)`)
    startWorker()
    nitro.hooks.hook('close', () => stopWorker())
  } catch (err) {
    console.error('[runtime] boot failed — agent turns will not run until restart:', err)
  }
})
