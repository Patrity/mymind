// Cycle 82 (review I1 ruling): re-enable the network of a TAINTED workspace. Once a tainted run has
// executed a command in a workspace, every later command there runs with no network and no secrets
// (lib/sandbox/manager.ts) — files written while tainted may be hostile (git hooks, package scripts),
// so only Tony, deliberately, lifts it. Auth: web session only — a leaked API token (or the agent
// over /api/mcp) must never be able to hand a tainted workspace its network back.
// Only flips the flag: the networked container stays stopped until the worker's next command.
import { z } from 'zod'
import { requireSession } from '../../../utils/auth-guard'
import { reenableWorkspaceNetwork } from '@mymind/core/lib/sandbox/store'

export default defineEventHandler(async (event) => {
  requireSession(event)
  const id = getRouterParam(event, 'id')
  if (!id || !z.uuid().safeParse(id).success) throw createError({ statusCode: 404, statusMessage: 'No such workspace', data: { message: 'No such workspace.' } })
  const row = await reenableWorkspaceNetwork(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'No such workspace', data: { message: 'No such workspace.' } })
  return { id: row.id, tainted: row.tainted, taintedAt: row.taintedAt?.toISOString() ?? null }
})
