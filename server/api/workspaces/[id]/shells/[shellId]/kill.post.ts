// Cycle 82 Task 3: Tony stops a background shell (its whole process group) from the Shells tab.
// Session only — a leaked API token (or the agent over /api/mcp) can't drive the UI's writes.
import { requireSession } from '../../../../../utils/auth-guard'
import { askWorker, requireShellId, requireWorkspaceUuid } from '../../../../../utils/workspaces-http'

export default defineEventHandler(async (event) => {
  requireSession(event)
  const workspaceId = requireWorkspaceUuid(event)
  const shellId = requireShellId(event)
  return askWorker('workspace-kill-shell', { workspaceId, shellId })
})
