// POST /api/jobs/:slug/revert — restore a job to a prior revision's content (recorded as a NEW
// revision). Existence is checked up front: revertJob throws a proper JobNotFoundError for a
// missing job, but also throws a plain Error when revisionId doesn't belong to this job — that
// plain-Error case is a validation failure (bad revisionId), not a missing-job one, so it falls
// through throwAgentConfigWriteError's generic 400 branch rather than being mistaken for 404.
import { z } from 'zod'
import { getJob, revertJob } from '@mymind/core/lib/agent/jobs/store'
import { requireJobSlug, throwAgentConfigWriteError } from '../../../utils/agent-config-http'

const Body = z.object({ revisionId: z.string() })

export default defineEventHandler(async (event) => {
  const slug = requireJobSlug(event)
  let revisionId: string
  try {
    ({ revisionId } = Body.parse(await readBody(event)))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  const job = await getJob(slug)
  if (!job) throw createError({ statusCode: 404, statusMessage: `no job named "${slug}"` })
  try {
    return await revertJob(slug, revisionId, 'human')
  } catch (err) {
    throwAgentConfigWriteError(err)
  }
})
