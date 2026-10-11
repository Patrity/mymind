// Cycle 82 (review I1 ruling): re-enable the network of a TAINTED workspace. Once a tainted run has
// executed a command in a workspace, every later command there runs with no network and no secrets
// (lib/sandbox/manager.ts) — files written while tainted may be hostile (git hooks, package scripts),
// so only Tony, deliberately, lifts it. Auth: web session only — a leaked API token (or the agent
// over /api/mcp) must never be able to hand a tainted workspace its network back.
// The WORKER does it (rereview #5): it first kills every tainted run of the workspace, then clears
// the flag — so no tainted write lands after the workspace is trusted again. A dead worker → 504,
// never a silent OK (the flag stays set).
import { z } from 'zod'
import { requireSession } from '../../../utils/auth-guard'
import { sendCommand, CommandFailedError, CommandTimeoutError } from '@mymind/core/lib/bus/commands'

const REENABLE_TIMEOUT_MS = 60_000

export default defineEventHandler(async (event) => {
  requireSession(event)
  const id = getRouterParam(event, 'id')
  if (!id || !z.uuid().safeParse(id).success) throw createError({ statusCode: 404, statusMessage: 'No such workspace', data: { message: 'No such workspace.' } })
  try {
    // ~60s (rereview minor 2): the worker first waits for in-flight tainted commands to end and their
    // one-off containers to go (bounded well under this), so the default 10s could report "stays off"
    // for a re-enable that then succeeds.
    const r = await sendCommand('workspace-reenable-network', { workspaceId: id }, { awaitResult: true, timeoutMs: REENABLE_TIMEOUT_MS })
    if (!r) throw new Error('the agent worker returned nothing')
    return r
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof CommandTimeoutError) throw createError({ statusCode: 504, statusMessage: 'Agent worker did not answer', data: { message: 'The agent worker did not answer, so the network stays off. Is it running?' } })
    if (err instanceof CommandFailedError) {
      const notFound = /not found|has been deleted/i.test(message)
      throw createError({ statusCode: notFound ? 404 : 409, statusMessage: notFound ? 'No such workspace' : 'Refused', data: { message } })
    }
    throw err
  }
})
