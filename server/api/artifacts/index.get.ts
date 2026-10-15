import { listArtifacts } from '@mymind/core/lib/artifacts/service'

// GET /api/artifacts?project=<uuid> — newest-updated first.
export default defineEventHandler(async (event) => {
  const { project } = getQuery(event)
  return listArtifacts({ projectId: typeof project === 'string' && project ? project : undefined })
})
