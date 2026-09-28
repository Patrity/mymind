// GET /api/jobs — every job, newest-slug-first-... actually slug-ascending (listJobs' own order),
// each with `description` filled by describeTrigger via listJobs' rowToJobDTO. No route-level
// logic needed: listJobs already returns the full JobDTO[] contract.
import { listJobs } from '../../lib/agent/jobs/store'

export default defineEventHandler(async () => listJobs())
