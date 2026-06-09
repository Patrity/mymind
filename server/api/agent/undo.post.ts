// server/api/agent/undo.post.ts
import { z } from 'zod'
import { runUndo } from '../../lib/agent/undo'

const Body = z.object({ token: z.string().min(1) })

export default defineEventHandler(async (event) => {
  const { token } = Body.parse(await readBody(event))
  const ok = await runUndo(token)
  return { ok }
})
