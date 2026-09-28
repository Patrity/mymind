import { deleteJob } from '../../lib/agent/jobs/store'
import { requireJobSlug } from '../../utils/agent-config-http'

export default defineEventHandler(async (event) => {
  const slug = requireJobSlug(event)
  // deleteJob publishes the `agentJob` live event itself.
  const deleted = await deleteJob(slug)
  if (!deleted) throw createError({ statusCode: 404, statusMessage: `no job named "${slug}"` })
  return { deleted: slug }
})
