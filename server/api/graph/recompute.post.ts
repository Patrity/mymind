// Manually trigger a full galaxy layout recompute. Auth-gated by
// server/middleware/auth.ts (same implicit guard as index.get.ts). Also runs
// nightly via the compute-graph-layout scheduled task.
import { runComputeGraphLayout } from '../../tasks/compute-graph-layout'

export default defineEventHandler(async () => {
  const summary = await runComputeGraphLayout()
  return { ok: true, summary }
})
