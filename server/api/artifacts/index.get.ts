import { listArtifacts } from '@mymind/core/lib/artifacts/service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/artifacts?project=<uuid> — newest-updated first. A malformed project id is a 400 (it would be
// a Postgres uuid cast error → 500 otherwise); an empty one means no filter.
export default defineEventHandler(async (event) => {
  const { project } = getQuery(event)
  if (project !== undefined && project !== '' && (typeof project !== 'string' || !UUID_RE.test(project)))
    throw createError({ statusCode: 400, statusMessage: 'project must be a project id (uuid)' })
  return listArtifacts({ projectId: typeof project === 'string' && project ? project : undefined })
})
