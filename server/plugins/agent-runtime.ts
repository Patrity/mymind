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
  } catch (err) {
    console.error('[runtime] failed to read the agent_runtime flag — agent turns will not run until restart:', err)
    return
  }
  try {
    const n = await recoverOnBoot()
    if (n) console.warn(`[runtime] recovered ${n} interrupted run(s)`)
  } catch (err) {
    // Boot recovery is a head start, not a precondition (Task 8 review, fix round 1): the
    // worker's periodic tick runs this exact recover-and-note pass every 5s and will catch
    // whatever this one-time pass missed, so a failure here must not stop turns from running
    // at all — only this one boot-time sweep is skipped.
    console.error('[runtime] boot recovery failed — starting the worker anyway; the periodic tick will retry shortly:', err)
  }
  startWorker()
  nitro.hooks.hook('close', () => stopWorker())
})
