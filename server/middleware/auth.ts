import { eq, and, isNull } from 'drizzle-orm'
import { useDb } from '../db'
import { apiTokens } from '../db/schema'
import { hashToken } from '../utils/api-token'

const PUBLIC_PREFIXES = ['/api/auth', '/api/share']

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event).pathname
  if (!url.startsWith('/api')) return
  if (PUBLIC_PREFIXES.some(p => url.startsWith(p))) return

  // 1) bearer API token (machine clients)
  const authz = getHeader(event, 'authorization')
  if (authz?.startsWith('Bearer ')) {
    const db = useDb()
    const [row] = await db.select().from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, hashToken(authz.slice(7))), isNull(apiTokens.revokedAt)))
      .limit(1)
    if (row) {
      event.context.client = { type: 'api-token', tokenId: row.id }
      // Fire-and-forget lastUsedAt update — errors are intentionally swallowed
      db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id)).execute().catch(() => {})
      return
    }
  }

  // 2) session (web app)
  // better-auth 1.6.13: api.getSession requires { headers: HeadersInit }
  // H3 v2 event.headers is a native Headers object (implements HeadersInit)
  const session = await useAuth().api.getSession({ headers: event.headers as Headers }).catch(() => null)
  if (session?.user) {
    event.context.user = session.user
    event.context.client = { type: 'session', userId: session.user.id }
    return
  }

  throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
})
