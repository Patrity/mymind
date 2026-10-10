// GET /api/jobs — every job, newest-slug-first-... actually slug-ascending (listJobs' own order),
// each with `description` filled by describeTrigger via listJobs' rowToJobDTO. No route-level
// logic needed: listJobs already returns the full JobDTO[] contract.
import { listJobs, getDefaultTimezone } from '@mymind/core/lib/agent/jobs/store'

// A row stores its resolved timezone; only an unparseable one can have none. Those get the server
// default (read only when needed) so the page never falls back to the browser's zone.
export default defineEventHandler(async () => {
  const jobs = await listJobs()
  if (jobs.every(j => j.timezone)) return jobs
  const timezone = await getDefaultTimezone()
  return jobs.map(j => (j.timezone ? j : { ...j, timezone }))
})
