// PUT /api/jobs/:slug — CAS save of a job's whole markdown. `expectedHash` is the contentHash
// the editor loaded; a mismatch (or a job that no longer exists while expectedHash is set)
// throws ConflictError/JobNotFoundError, mapped below.
import { z } from 'zod'
import { saveJob } from '../../lib/agent/jobs/store'
import { requireJobSlug, throwAgentConfigWriteError } from '../../utils/agent-config-http'

const Body = z.object({ content: z.string(), expectedHash: z.string().nullable() })

export default defineEventHandler(async (event) => {
  const slug = requireJobSlug(event)
  let input: z.infer<typeof Body>
  try {
    input = Body.parse(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  try {
    return await saveJob(slug, input.content, input.expectedHash, 'human')
  } catch (err) {
    throwAgentConfigWriteError(err)
  }
})
