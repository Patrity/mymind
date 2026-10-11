// Cycle 82 Task 3: the Files tab's tree (≤ 500 entries) — listed INSIDE the sandbox by the worker.
import { askWorker, requireWorkspace } from '../../../utils/workspaces-http'
import type { WorkspaceTree } from '@mymind/core/shared/types/workspaces'

export default defineEventHandler(async (event) => {
  const ws = await requireWorkspace(event)
  return await askWorker('workspace-view', { op: 'tree', workspaceId: ws.id }) as WorkspaceTree
})
