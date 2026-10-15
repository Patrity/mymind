import { getArtifactDetail, resolveArtifactRef } from '@mymind/core/lib/artifacts/service'

// GET /api/artifacts/:id — :id is an artifact id or slug.
export default defineEventHandler(async (event) => {
  const id = await resolveArtifactRef(getRouterParam(event, 'id')!)
  const detail = id ? await getArtifactDetail(id) : null
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'artifact not found' })
  return detail
})
