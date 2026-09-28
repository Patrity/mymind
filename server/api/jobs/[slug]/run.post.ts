// POST /api/jobs/:slug/run — run now, outside the schedule (schedule untouched). runJobNow
// itself throws a plain (non-JobNotFoundError) Error for a missing slug, so existence is
// checked here first to give the "missing -> 404" contract a real class to key off of.
import { getJob } from '../../../lib/agent/jobs/store'
import { runJobNow } from '../../../lib/agent/jobs/tick'
import { requireJobSlug } from '../../../utils/agent-config-http'

export default defineEventHandler(async (event) => {
  const slug = requireJobSlug(event)
  const job = await getJob(slug)
  if (!job) throw createError({ statusCode: 404, statusMessage: `no job named "${slug}"` })
  return runJobNow(slug)
})
