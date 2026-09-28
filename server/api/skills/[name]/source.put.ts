// PUT /api/skills/:name/source — CAS save of a skill's whole markdown (create when
// expectedHash is null, update-with-CAS otherwise) — the editor's counterpart to
// server/api/skills/[name].put.ts's structured-field update. saveSkillSource's own not-found
// signal is a plain Error indistinguishable by type from a validation one (skills has no
// dedicated NotFoundError class), so existence is checked up front on the update path to give
// "missing -> 404" a real signal instead of falling into the generic 400 branch.
import { z } from 'zod'
import { getSkillSource, saveSkillSource } from '../../../services/skills'
import { requireSkillName, throwAgentConfigWriteError } from '../../../utils/agent-config-http'

const Body = z.object({ content: z.string(), expectedHash: z.string().nullable() })

export default defineEventHandler(async (event) => {
  const name = requireSkillName(event)
  let input: z.infer<typeof Body>
  try {
    input = Body.parse(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  if (input.expectedHash !== null && !(await getSkillSource(name))) {
    throw createError({ statusCode: 404, statusMessage: `no skill named "${name}"` })
  }
  try {
    // saveSkillSource publishes the `agentSkill` live event itself.
    return await saveSkillSource(name, input.content, input.expectedHash, 'human')
  } catch (err) {
    throwAgentConfigWriteError(err)
  }
})
