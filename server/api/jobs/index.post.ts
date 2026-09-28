// POST /api/jobs — create a new job from markdown. `slug` shape and content validity are both
// enforced inside createJob (writeJob): a bad slug or unparseable content throws
// JobValidationError -> 400; a slug that already exists throws ConflictError -> 409
// (expectedHash:null is create-only, mirrors saveSkillSource).
import { z } from 'zod'
import { createJob } from '../../lib/agent/jobs/store'
import { throwAgentConfigWriteError } from '../../utils/agent-config-http'

const Body = z.object({ slug: z.string(), content: z.string() })

export default defineEventHandler(async (event) => {
  let input: z.infer<typeof Body>
  try {
    input = Body.parse(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  try {
    const job = await createJob({ slug: input.slug, content: input.content, actor: 'human' })
    setResponseStatus(event, 201)
    return job
  } catch (err) {
    throwAgentConfigWriteError(err)
  }
})
