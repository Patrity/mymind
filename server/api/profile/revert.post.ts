// POST /api/profile/revert — restore the "About Tony" profile to a prior revision's content
// (recorded as a NEW revision).
import { z } from 'zod'
import { requireSession } from '../../utils/auth-guard'
import { revertProfile } from '../../services/profile'
import { throwAgentConfigWriteError } from '../../utils/agent-config-http'

const Body = z.object({ revisionId: z.string() })

export default defineEventHandler(async (event) => {
  requireSession(event)
  let revisionId: string
  try {
    ({ revisionId } = Body.parse(await readBody(event)))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  try {
    return await revertProfile(revisionId, 'human')
  } catch (err) {
    throwAgentConfigWriteError(err)
  }
})
