// POST /api/skills/:name/revert — restore a skill to a prior revision's content (recorded as a
// NEW revision). Existence is checked up front for the same reason as jobs' revert.post.ts:
// revertSkill throws a plain Error for both "no skill named ..." and "revision doesn't belong",
// and only the pre-check can tell those apart to give the first one a real 404.
import { z } from 'zod'
import { getSkillSource, revertSkill } from '@mymind/core/services/skills'
import { requireSkillName, throwAgentConfigWriteError } from '../../../utils/agent-config-http'

const Body = z.object({ revisionId: z.string() })

export default defineEventHandler(async (event) => {
  const name = requireSkillName(event)
  let revisionId: string
  try {
    ({ revisionId } = Body.parse(await readBody(event)))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  if (!(await getSkillSource(name))) {
    throw createError({ statusCode: 404, statusMessage: `no skill named "${name}"` })
  }
  try {
    return await revertSkill(name, revisionId, 'human')
  } catch (err) {
    throwAgentConfigWriteError(err)
  }
})
