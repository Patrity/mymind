// Auth: session OR API token, like agent/chat.post.ts (controller ruling, Task 6 fix round 1).
import { z } from 'zod'
import { requireWorkstreamId, sendWorkstreamControl } from '../../../utils/workstreams-http'

const Body = z.object({ text: z.string().trim().min(1).max(8000) })

/** Words for a workstream (spec §5.4): while it runs they steer it; while it waits on a question
 *  they are the answer (its next segment starts with them). The worker decides which. */
export default defineEventHandler(async (event) => {
  const id = requireWorkstreamId(event)
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Text required', data: { message: 'Write something first.' } })
  return sendWorkstreamControl(id, 'steer', parsed.data.text)
})
