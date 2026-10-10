// GET /api/profile/source — the "About Tony" profile plus its prompt-budget status (Task 2).
// Session-only, like the other config editor routes — see server/utils/auth-guard.ts.
import { requireSession } from '../../utils/auth-guard'
import { getProfileSource } from '@mymind/core/services/profile'
import { estimateTokens, PROFILE_TOKEN_BUDGET } from '@mymind/core/lib/agent/profile-budget'

export default defineEventHandler(async (event) => {
  requireSession(event)
  const source = await getProfileSource()
  const tokens = estimateTokens(source.content)
  return { ...source, tokens, budget: PROFILE_TOKEN_BUDGET, overBudget: tokens > PROFILE_TOKEN_BUDGET }
})
