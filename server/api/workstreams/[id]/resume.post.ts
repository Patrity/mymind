// Auth: web session only (final review I5, superseding the Task 6 ruling) — the same rule as
// server/api/admin/agent/wake.post.ts: the auth middleware also accepts a bearer API token, and a
// leaked token must not be able to start an unattended background run (a workstream is the largest
// one: up to 2000 steps / 24h). Cancel and steer stay token-capable.
import { requireSession } from '../../../utils/auth-guard'
import { requireWorkstreamId, sendWorkstreamControl } from '../../../utils/workstreams-http'

/** Resume a failed/cancelled (or waiting) workstream. A used-up budget is extended by
 *  RESUME_EXTENSION (shared/types/workstreams.ts) — the UI says so on the button. */
export default defineEventHandler(async (event) => {
  requireSession(event)
  return sendWorkstreamControl(requireWorkstreamId(event), 'resume')
})
