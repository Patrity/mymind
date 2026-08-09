// server/api/agent/undo.post.ts
import { z } from 'zod'
import { runUndo } from '../../lib/agent/undo'

const Body = z.object({ token: z.string().min(1) })

export default defineEventHandler(async (event) => {
  const { token } = Body.parse(await readBody(event))
  // runUndo catches a throwing undo closure itself, so a failed undo comes back as
  // { ok: false, reason } with a 200 rather than a raw 500 — see its comment.
  const res = await runUndo(token)
  return res    // { ok, reason? }
})
