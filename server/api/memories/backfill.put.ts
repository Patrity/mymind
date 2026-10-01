// PUT /api/memories/backfill { state: 'running' | 'off' } — Start / Pause the dual-score backfill
// (cycle 77). `done` is not accepted: only the backfill itself finishes a run. Session-only: a
// leaked machine token must not be able to start the spend — see server/utils/auth-guard.ts.
// The service publishes `memoryBackfill` on a change; returns the fresh progress.
import { z } from 'zod'
import { requireSession } from '../../utils/auth-guard'
import { backfillProgress, setBackfillSwitch } from '../../services/memory-backfill'

const Body = z.object({ state: z.enum(['running', 'off']) })

export default defineEventHandler(async (event) => {
  requireSession(event)
  let state: z.infer<typeof Body>['state']
  try {
    ({ state } = Body.parse(await readBody(event)))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  await setBackfillSwitch(state)
  return backfillProgress()
})
