// Cycle 86 (option C): mark a TAINTED workspace trusted — clears its taint flag, so runs reading it
// are no longer treated as having read untrusted content (lib/sandbox/store.ts markWorkspaceTrusted).
// Auth: web session only — a leaked API token (or the agent over /api/mcp) must never be able to
// launder mail-derived content by un-tainting the workspace that holds it.
import { requireSession } from '../../../utils/auth-guard'
import { requireWorkspace, toWorkspaceDTO } from '../../../utils/workspaces-http'
import { markWorkspaceTrusted } from '@mymind/core/lib/sandbox/store'

export default defineEventHandler(async (event) => {
  requireSession(event)
  const ws = await requireWorkspace(event)
  const row = await markWorkspaceTrusted(ws.id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found', data: { message: 'No such workspace.' } })
  return toWorkspaceDTO(row)
})
