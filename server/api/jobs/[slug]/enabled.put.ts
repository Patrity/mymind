// PUT /api/jobs/:slug/enabled — flips only the `enabled:` frontmatter line (setJobEnabled),
// going through the normal write path so derived columns + a revision stay consistent.
import { z } from 'zod'
import { setJobEnabled } from '@mymind/core/lib/agent/jobs/store'
import { requireJobSlug, throwAgentConfigWriteError } from '../../../utils/agent-config-http'

const Body = z.object({ enabled: z.boolean() })

export default defineEventHandler(async (event) => {
  const slug = requireJobSlug(event)
  let enabled: boolean
  try {
    ({ enabled } = Body.parse(await readBody(event)))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  try {
    return await setJobEnabled(slug, enabled, 'human')
  } catch (err) {
    throwAgentConfigWriteError(err)
  }
})
