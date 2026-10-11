// Cycle 81 (Task 2 review M2): the iMessage catch-up — and with it the BlueBubbles health snapshot
// and its `running` guard (inbound.ts, module state) — belongs to the process that executes agent
// runs. These are the web routes' entry points; they work in either execution mode:
//   local  (AGENT_EXECUTOR=web): this process runs the catch-up — read/refresh/reset it in memory.
//   remote (AGENT_EXECUTOR=worker): the worker owns it. Health = what the worker published with its
//          latest heartbeat (worker_heartbeat.status.imessage); a forced check or a reset is an
//          `imessage-health` command to the worker, so only ONE catch-up ever runs at a time.
import { executionMode } from '../agent/runtime/execution-mode'
import { sendCommand, workerStatus } from '../bus/commands'
import { catchUpTick, lastHealth, resetHealth, type ImessageHealth } from './inbound'

const UNKNOWN: ImessageHealth = { ok: false, privateApi: null, checkedAt: null }
/** A forced catch-up talks to BlueBubbles; give it longer than the default 10s command timeout. */
export const IMESSAGE_CHECK_TIMEOUT_MS = 30_000

/** The health the Settings → Channels nav dot shows. */
export async function currentImessageHealth(): Promise<ImessageHealth> {
  if (executionMode() !== 'remote') return lastHealth()
  const w = await workerStatus()
  if (!w.online) return { ...UNKNOWN, error: 'the agent worker is offline' }
  return w.status?.imessage ?? UNKNOWN
}

/** A forced catch-up (health check + scan) in the owning process; resolves with the fresh health.
 *  Never throws — a failure is logged and the last known health returned. */
export async function checkImessageHealth(): Promise<ImessageHealth> {
  try {
    if (executionMode() === 'remote') {
      return (await sendCommand('imessage-health', { action: 'check' }, { awaitResult: true, timeoutMs: IMESSAGE_CHECK_TIMEOUT_MS })) ?? UNKNOWN
    }
    await catchUpTick({ force: true })
  } catch (err) {
    console.warn('[channels] test catch-up failed:', err instanceof Error ? err.message : err)
  }
  return currentImessageHealth().catch(() => UNKNOWN)
}

/** Forget the health snapshot after the channel config changed (in the owning process). */
export async function resetImessageHealth(): Promise<void> {
  if (executionMode() !== 'remote') { resetHealth(); return }
  await sendCommand('imessage-health', { action: 'reset' })
    .catch(err => console.warn('[channels] health reset command failed:', err instanceof Error ? err.message : err))
}
