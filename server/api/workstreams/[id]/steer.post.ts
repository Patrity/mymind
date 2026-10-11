// Auth: web session only (fix-wave re-review NEW-1, in every state). A steer can be an answer or
// continue a paused workstream — i.e. it can (re)start unattended work — so it follows start/resume
// and wake.post.ts: a leaked API token must not be able to drive a background run. Cancel stays
// token-capable (stopping work never widens it).
import { z } from 'zod'
import { requireSession } from '../../../utils/auth-guard'
import { requireWorkstreamId, sendWorkstreamControl } from '../../../utils/workstreams-http'

const Body = z.object({ text: z.string().trim().min(1).max(8000) })

/** Words for a workstream (spec §5.4): while it runs they steer it; while it waits on a question
 *  they are the answer (its next segment starts with them). The worker decides which. */
export default defineEventHandler(async (event) => {
  requireSession(event)
  const id = requireWorkstreamId(event)
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Text required', data: { message: 'Write something first.' } })
  return sendWorkstreamControl(id, 'steer', parsed.data.text)
})
