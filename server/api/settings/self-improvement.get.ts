// GET /api/settings/self-improvement — Bridget's self-improvement mode (cycle 76):
// 'on' | 'review_only' | 'off'. Session-only: a leaked machine token must not be able to read
// or flip the gate — see server/utils/auth-guard.ts.
import { requireSession } from '../../utils/auth-guard'
import { getSelfImprovementMode } from '@mymind/core/lib/agent/self-improvement-mode'

export default defineEventHandler(async (event) => {
  requireSession(event)
  return { mode: await getSelfImprovementMode() }
})
