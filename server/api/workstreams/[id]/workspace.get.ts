// Cycle 82 Task 3: a workstream's workspace (created at its start; 404 for an older workstream).
import { eq } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { workspaces } from '@mymind/core/db/schema'
import { requireWorkstreamId } from '../../../utils/workstreams-http'
import { toWorkspaceDTO } from '../../../utils/workspaces-http'

export default defineEventHandler(async (event) => {
  const id = requireWorkstreamId(event)
  const [row] = await useDb().select().from(workspaces).where(eq(workspaces.workstreamId, id)).limit(1)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'No workspace', data: { message: 'This workstream has no workspace yet.' } })
  return toWorkspaceDTO(row)
})
