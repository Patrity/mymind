import { getJob } from '@mymind/core/lib/agent/jobs/store'
import { listRevisions } from '@mymind/core/lib/agent/config/revisions'
import { requireJobSlug } from '../../../utils/agent-config-http'

export default defineEventHandler(async (event) => {
  const slug = requireJobSlug(event)
  const job = await getJob(slug)
  if (!job) throw createError({ statusCode: 404, statusMessage: `no job named "${slug}"` })
  return listRevisions('job', job.id)
})
