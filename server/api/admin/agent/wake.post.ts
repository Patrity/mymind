import { wake } from '@mymind/core/lib/agent/runtime/wake'
import { requireSession } from '../../../utils/auth-guard'

/**
 * Manual wake. Every `/api/admin/**` route sits behind the shared auth middleware
 * (server/middleware/auth.ts), but that middleware also accepts a bearer API token (machine
 * clients) — a leaked token must not be able to start an unattended background run on its own,
 * so this ALSO requires a real web session (requireSession throws 403 otherwise).
 */
export default defineEventHandler(async (event) => {
  requireSession(event)
  const body = (await readBody<{ reason?: string; prompt?: string; sessionKey?: string; model?: string }>(event)) ?? {}
  const sessionKey = body.sessionKey === 'main' || body.sessionKey?.startsWith('isolated:') || body.sessionKey?.startsWith('thread:')
    ? body.sessionKey as never : undefined
  try {
    return await wake({ reason: body.reason ?? 'admin', prompt: body.prompt ?? '', sessionKey, model: body.model ?? null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // wake()'s own validation ("wake: …") and resolveSession's not-found ("… not found") are
    // the only errors safe to surface as a client-facing 400. Anything else (a DB outage, an
    // unexpected throw deeper in enqueue) is a real failure — it must propagate as a 500, not
    // get laundered into "bad request", and it must be logged since nothing else will.
    if (msg.startsWith('wake: ') || msg.includes('not found')) throw createError({ statusCode: 400, statusMessage: msg })
    console.error('[agent] wake endpoint failed:', err)
    throw err
  }
})
