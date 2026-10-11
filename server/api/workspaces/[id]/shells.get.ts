// Cycle 82 Task 3: the Shells tab — a workspace's background shells, newest first (the registry rows;
// output is read on demand by shells/[shellId]/output). Commands are shown with secret values masked.
import { desc, eq } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { workspaceShells } from '@mymind/core/db/schema'
import { maskSecretValues } from '@mymind/core/lib/sandbox/secrets'
import { requireWorkspace } from '../../../utils/workspaces-http'
import type { WorkspaceShellDTO } from '@mymind/core/shared/types/workspaces'

export default defineEventHandler(async (event) => {
  const ws = await requireWorkspace(event)
  const rows = await useDb().select().from(workspaceShells).where(eq(workspaceShells.workspaceId, ws.id)).orderBy(desc(workspaceShells.startedAt)).limit(50)
  const out: WorkspaceShellDTO[] = rows.map(r => ({
    id: r.id, command: r.command, state: r.state, exitCode: r.exitCode, reason: r.reason,
    startedAt: r.startedAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null
  }))
  return maskSecretValues(out)
})
