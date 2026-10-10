// GET /api/jobs/:slug — the job DTO, its next 5 scheduled fire times, and its last 10 runs.
// The spec used for nextFireTimes is re-derived from the job's own content the same way
// tools/jobs.ts's get_job does — `isKnownModel` is deliberately omitted (fire times don't
// depend on whether the pinned model is still registered).
import { getJob, getDefaultTimezone } from '@mymind/core/lib/agent/jobs/store'
import { parseJob } from '@mymind/core/lib/agent/jobs/parse'
import { fireTimesAnchor, nextFireTimes } from '@mymind/core/lib/agent/jobs/schedule'
import { listRuns } from '@mymind/core/lib/agent/runtime/runs'
import { requireJobSlug } from '../../utils/agent-config-http'

export default defineEventHandler(async (event) => {
  const slug = requireJobSlug(event)
  const job = await getJob(slug)
  if (!job) throw createError({ statusCode: 404, statusMessage: `no job named "${slug}"` })

  // A row stores its resolved timezone; only an unparseable one can have none, and then the page
  // shows times in the server's default zone, never the browser's.
  const timezone = job.timezone ?? await getDefaultTimezone()
  const parsed = parseJob(job.content, { defaultTimezone: timezone })
  // An enabled job's stored next_run_at anchors an `every` cadence (see nextFireTimes).
  const fireTimes = parsed.ok
    ? nextFireTimes(parsed.spec, 5, new Date(), { anchor: fireTimesAnchor(job) }).map(d => d.toISOString())
    : []

  const runs = await listRuns({ jobId: job.id, limit: 10 })

  return {
    job: { ...job, timezone, deliver: parsed.ok ? parsed.spec.deliver : [] },
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
