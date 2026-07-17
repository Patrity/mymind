import { eq, and, isNull } from 'drizzle-orm'
import { useDb } from '../db'
import { apiTokens } from '../db/schema'
import { hashToken } from '../utils/api-token'
import { mcpAuthChallengeHeader, oauthOrigin } from '../utils/oauth-metadata'

const PUBLIC_PREFIXES = ['/api/auth', '/api/share', '/api/i', '/api/setup', '/api/health']

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event).pathname
  if (!url.startsWith('/api/') && url !== '/api') return
  if (PUBLIC_PREFIXES.some(p => url === p || url.startsWith(p + '/'))) return

  const isMcp = url === '/api/mcp' || url.startsWith('/api/mcp/')
  const unauthorized = () => {
    // On the MCP route the 401 carries the RFC 9728 pointer Claude needs to
    // bootstrap OAuth discovery; everywhere else keep the bare challenge.
    setResponseHeader(event, 'www-authenticate', isMcp
      ? mcpAuthChallengeHeader(oauthOrigin(useRuntimeConfig().betterAuthUrl as string | undefined))
      : 'Bearer')
    return createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

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
    // 1b) OAuth access token (MCP connectors) — only on the MCP route
    if (isMcp) {
      const oauthToken = await useAuth().api.getMcpSession({ headers: event.headers as Headers }).catch(() => null)
      if (oauthToken) {
        // better-auth's declared return type for getMcpSession (OAuthAccessToken, from
        // oidc-provider/types.d.mts) omits `id`, but the runtime handler returns the raw
        // oauth_access_token DB row unmodified, which always has one — see task-4-report.md.
        const tokenId = (oauthToken as typeof oauthToken & { id: string }).id
        event.context.client = { type: 'oauth', tokenId, userId: oauthToken.userId ?? undefined }
        return
      }
    }
    throw unauthorized()
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

  throw unauthorized()
})
