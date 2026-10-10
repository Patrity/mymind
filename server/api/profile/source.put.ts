// PUT /api/profile/source — CAS save of the "About Tony" profile's whole markdown. Unlike a
// skill, the profile is a singleton with no create-only mode: expectedHash is always the hash of
// whatever is currently stored (the lazily-created empty row's hash on a first-ever save).
import { z } from 'zod'
import { requireSession } from '../../utils/auth-guard'
import { saveProfileSource } from '@mymind/core/services/profile'
import { throwAgentConfigWriteError } from '../../utils/agent-config-http'

const Body = z.object({ content: z.string(), expectedHash: z.string() })

export default defineEventHandler(async (event) => {
  requireSession(event)
  let input: z.infer<typeof Body>
  try {
    input = Body.parse(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  try {
    // saveProfileSource publishes the `agentProfile` live event itself.
    return await saveProfileSource(input.content, input.expectedHash, 'human')
  } catch (err) {
    throwAgentConfigWriteError(err)
  }
})
