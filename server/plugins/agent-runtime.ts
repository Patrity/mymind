import { recoverOnBoot } from '../lib/agent/runtime/recover'
import { startWorker, stopWorker } from '../lib/agent/runtime/queue'
import { installSeedJobs, revalidateAll } from '../lib/agent/jobs/store'

// Boot order: recover runs orphaned by the previous process, then start the worker. Recovery
// before the worker so a stale 'running' row cannot block its conversation's queue for the 60s
// it would take to look orphaned.
export default defineNitroPlugin(async (nitro) => {
  if (import.meta.prerender) return
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
  try {
    const installed = await installSeedJobs()
    if (installed) console.info(`[runtime] installed ${installed} seed job(s), disabled`)
  } catch (err) {
    // Same reasoning as recovery above: a head start, not a precondition. A failure here must
    // not stop turns from running.
    console.error('[runtime] seed job install failed:', err)
  }
  try {
    const changed = await revalidateAll()
    if (changed) console.warn(`[runtime] revalidated jobs on boot — ${changed} job(s) changed validity`)
  } catch (err) {
    console.error('[runtime] job revalidation failed:', err)
  }
  startWorker()
  nitro.hooks.hook('close', () => stopWorker())
})
