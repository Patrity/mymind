// Cycle 81: the executor's boot sequence — the agent worker's (apps/worker, the only executor). Moved
// verbatim from the web's server/plugins/agent-runtime.ts.
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

export interface BootRetry {
  /** Give up retrying recovery after this long (then the periodic stale sweep is the net). */
  maxMs: number
  baseMs: number
  maxDelayMs: number
  /** True once the process is draining: stop retrying. */
  stopped?: () => boolean
  sleep?: (ms: number) => Promise<void>
}
export const DEFAULT_BOOT_RETRY: BootRetry = { maxMs: 120_000, baseMs: 1_000, maxDelayMs: 10_000 }

/**
 * Boot recovery, retried with bounded backoff (Task 2 review M7). On a cold host boot the DB can come
 * up after the worker; a single failed attempt would lose the EXCLUSIVE takeover (a previous boot's
 * fresh 'running' runs would then wait for the 60s age-only sweep). Retries until it succeeds, the
 * budget runs out, or a drain starts.
 */
async function recoverWithRetry(steps: BootSteps, retry: BootRetry): Promise<number> {
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const until = Date.now() + retry.maxMs
  let delay = retry.baseMs
  for (let attempt = 1; ; attempt++) {
    try {
      return await steps.recoverOrphans()
    } catch (err) {
      const left = until - Date.now()
      if (left <= 0 || retry.stopped?.()) throw err
      console.warn(`[runtime] boot recovery attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}); retrying in ${Math.min(delay, left)}ms`)
      await sleep(Math.min(delay, left))
      delay = Math.min(delay * 2, retry.maxDelayMs)
    }
  }
}

export async function bootAgentRuntime(steps: BootSteps = realSteps, retry: BootRetry = DEFAULT_BOOT_RETRY): Promise<{ recovered: number }> {
  let recovered = 0
  try {
    recovered = await recoverWithRetry(steps, retry)
    if (recovered) console.warn(`[runtime] recovered ${recovered} interrupted run(s)`)
  } catch (err) {
    console.error('[runtime] boot recovery failed — starting the pump anyway; the periodic tick will retry shortly:', err)
  }
  if (retry.stopped?.()) return { recovered }
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
