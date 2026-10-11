// server/api/agent/undo.post.ts
import { z } from 'zod'
import { redeemUndo } from '@mymind/core/lib/agent/undo-remote'

const Body = z.object({ token: z.string().min(1) })

export default defineEventHandler(async (event) => {
  const { token } = Body.parse(await readBody(event))
  // A token minted in THIS process (a /review approval, memory archive, triage) is redeemed here;
  // any other — every tool call of an agent run — belongs to apps/worker and is redeemed there by
  // an `undo` command (cycle 81, spec D4). Either way the answer is the real { ok, reason? }: a
  // refusal, a thrown closure and a worker that doesn't answer within 10s all come back as
  // { ok: false, reason } with a 200, which every caller already surfaces (undo-feedback.ts).
  return await redeemUndo(token)
})
