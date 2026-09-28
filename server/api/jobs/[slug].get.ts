// GET /api/jobs/:slug — the job DTO, its next 5 scheduled fire times, and its last 10 runs.
// The spec used for nextFireTimes is re-derived from the job's own content the same way
// tools/jobs.ts's get_job does — `isKnownModel` is deliberately omitted (fire times don't
// depend on whether the pinned model is still registered).
import { getJob, getDefaultTimezone } from '../../lib/agent/jobs/store'
import { parseJob } from '../../lib/agent/jobs/parse'
import { nextFireTimes } from '../../lib/agent/jobs/schedule'
import { listRuns } from '../../lib/agent/runtime/runs'
import { requireJobSlug } from '../../utils/agent-config-http'

export default defineEventHandler(async (event) => {
  const slug = requireJobSlug(event)
  const job = await getJob(slug)
  if (!job) throw createError({ statusCode: 404, statusMessage: `no job named "${slug}"` })

  const parsed = parseJob(job.content, { defaultTimezone: job.timezone ?? await getDefaultTimezone() })
  // An enabled job's stored next_run_at anchors an `every` cadence (see nextFireTimes).
  const anchor = job.enabled && job.nextRunAt ? new Date(job.nextRunAt) : null
  const fireTimes = parsed.ok ? nextFireTimes(parsed.spec, 5, new Date(), { anchor }).map(d => d.toISOString()) : []

  const runs = await listRuns({ jobId: job.id, limit: 10 })

  return {
    job,
    nextFireTimes: fireTimes,
    runs: runs.map(r => ({
      id: r.id,
      status: r.status,
      suppressed: r.suppressed,
      createdAt: r.createdAt.toISOString(),
      durationMs: r.claimedAt && r.finishedAt ? r.finishedAt.getTime() - r.claimedAt.getTime() : null,
      conversationId: r.conversationId,
      assistantMessageId: r.assistantMessageId
    }))
  }
})
