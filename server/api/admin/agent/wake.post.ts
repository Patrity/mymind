import { wake } from '../../../lib/agent/runtime/wake'

/** Manual wake (admin, session-authed by server middleware like every /api/admin route). */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ reason?: string; prompt?: string; sessionKey?: string; model?: string }>(event)
  const sessionKey = body.sessionKey === 'main' || body.sessionKey?.startsWith('isolated:') || body.sessionKey?.startsWith('thread:')
    ? body.sessionKey as never : undefined
  try {
    return await wake({ reason: body.reason ?? 'admin', prompt: body.prompt ?? '', sessionKey, model: body.model ?? null })
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
})
