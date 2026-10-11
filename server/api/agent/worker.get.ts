import { workerStatus } from '@mymind/core/lib/bus/commands'

/** Is the agent worker alive? (cycle 81 spec §6: newest heartbeat in this namespace ≤ 30s old.)
 *  The /agent and /workstreams pages poll this for the "agent worker offline" banner. */
export default defineEventHandler(async () => {
  const s = await workerStatus(30_000)
  // Cycle 82 final review I6: the worker's sandbox preflight (null until its first check).
  return { online: s.online, beatAt: s.beatAt?.toISOString() ?? null, sandbox: s.status?.sandbox ?? null }
})
