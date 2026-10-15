import { getArtifactDetail, resolveArtifactRef } from '@mymind/core/lib/artifacts/service'
import { signViewToken } from '@mymind/core/lib/artifacts/token'
import { requireSession } from '../../../utils/auth-guard'

// GET /api/artifacts/:id/view-url — relative URL; private artifacts get a signed, expiring token.
// Session-only: an API token must never mint view tokens.
export default defineEventHandler(async (event) => {
  requireSession(event)
  const id = await resolveArtifactRef(getRouterParam(event, 'id')!)
  const a = id ? await getArtifactDetail(id) : null
  if (!a) throw createError({ statusCode: 404, statusMessage: 'artifact not found' })
  return { url: a.isPublic ? `/artifact/${a.slug}/` : `/artifact/${a.slug}/~${signViewToken(a.id)}/` }
})
