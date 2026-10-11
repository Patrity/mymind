// Cycle 81: the executor's boot sequence, shared by the agent worker (apps/worker) and — while
// AGENT_EXECUTOR=web (until Task 3) — the web's server/plugins/agent-runtime.ts. Moved verbatim from
// that plugin.
//
// Order: recover runs orphaned by the previous process BEFORE the pump starts, so a stale 'running'
// row cannot block its conversation's queue for the 60s it would take to look orphaned. Each step is
// a head start, not a precondition: a failure is logged and the next step still runs (the periodic
// tick repeats the recover-and-note pass every 5s).
import { recoverOnBoot } from './recover'
import { installSeedJobs, upgradeSeedJobs, revalidateAll } from '../jobs/store'

export interface BootSteps {
  recoverOrphans: () => Promise<number>
  installSeedJobs: () => Promise<number>
  upgradeSeedJobs: () => Promise<number>
  revalidateAll: () => Promise<number>
}

const realSteps: BootSteps = { recoverOrphans: () => recoverOnBoot(), installSeedJobs, upgradeSeedJobs, revalidateAll }

export async function bootAgentRuntime(steps: BootSteps = realSteps): Promise<{ recovered: number }> {
  let recovered = 0
  try {
    recovered = await steps.recoverOrphans()
    if (recovered) console.warn(`[runtime] recovered ${recovered} interrupted run(s)`)
  } catch (err) {
    console.error('[runtime] boot recovery failed — starting the pump anyway; the periodic tick will retry shortly:', err)
  }
  try {
    const installed = await steps.installSeedJobs()
    if (installed) console.info(`[runtime] installed ${installed} seed job(s), disabled`)
    const upgraded = await steps.upgradeSeedJobs()
    if (upgraded) console.info(`[runtime] upgraded ${upgraded} unedited seed job(s) to the current version`)
  } catch (err) {
    console.error('[runtime] seed job install failed:', err)
  }
  try {
    const changed = await steps.revalidateAll()
    if (changed) console.warn(`[runtime] revalidated jobs on boot — ${changed} job(s) changed validity`)
  } catch (err) {
    console.error('[runtime] job revalidation failed:', err)
  }
  return { recovered }
}
