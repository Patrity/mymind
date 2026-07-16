// Manually trigger a full galaxy layout recompute. Auth-gated by
// server/middleware/auth.ts (same implicit guard as index.get.ts). Also runs
// hourly via the compute-graph-layout scheduled task (which skips when the node
// set is unchanged); the manual path FORCES a full rebuild.
import { runComputeGraphLayout } from '../../tasks/compute-graph-layout'

export default defineEventHandler(async () => {
  const summary = await runComputeGraphLayout({ force: true })
  return { ok: true, summary }
})
