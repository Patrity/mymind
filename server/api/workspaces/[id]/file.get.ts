// Cycle 82 Task 3: the Files tab's viewer — ≤ 2000 lines / 1 MB (`truncated` beyond), read INSIDE the
// sandbox by the worker; secret values masked. The path is checked here, in the worker, and resolved
// in the container (never on this host).
import { askWorker, readScope, requirePath, requireWorkspace } from '../../../utils/workspaces-http'
import type { WorkspaceFileView } from '@mymind/core/shared/types/workspaces'

export default defineEventHandler(async (event) => {
  const path = requirePath(event)
  const ws = await requireWorkspace(event)
  return await askWorker('workspace-view', { op: 'file', workspaceId: ws.id, path, ...readScope(event) }) as WorkspaceFileView
})
