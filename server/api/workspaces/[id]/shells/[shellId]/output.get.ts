// Cycle 82 Task 3: a background shell's output tail (≤ 16 KB) + state, read INSIDE the sandbox by the
// worker. It never moves bash_output's offset (Bridget still sees everything new). Secrets masked.
import { askWorker, readScope, requireShellId, requireWorkspace } from '../../../../../utils/workspaces-http'
import type { WorkspaceShellTail } from '@mymind/core/shared/types/workspaces'

export default defineEventHandler(async (event) => {
  const shellId = requireShellId(event)
  const ws = await requireWorkspace(event)
  return await askWorker('workspace-view', { op: 'shell-tail', workspaceId: ws.id, shellId, ...readScope(event) }) as WorkspaceShellTail
})
