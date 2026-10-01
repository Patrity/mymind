// GET /api/memories/backfill — the dual-score backfill's switch state and progress (cycle 77):
// counts over live memories, ETA and the last run's error. Session-only, like the switch itself.
import { requireSession } from '../../utils/auth-guard'
import { backfillProgress } from '../../services/memory-backfill'

export default defineEventHandler(async (event) => {
  requireSession(event)
  return backfillProgress()
})
