import { deleteArtifact, resolveArtifactRef } from '@mymind/core/lib/artifacts/service'

// DELETE /api/artifacts/:id — soft delete; the service emits the live-bus change.
export default defineEventHandler(async (event) => {
  const id = await resolveArtifactRef(getRouterParam(event, 'id')!)
  if (!id || !(await deleteArtifact(id))) throw createError({ statusCode: 404, statusMessage: 'artifact not found' })
  return { ok: true }
})
