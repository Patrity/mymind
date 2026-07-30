import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { oauthApplication } from '../../../db/schema'
import { clientDisplayName, redirectHosts } from '../../../utils/oauth-client'

/**
 * Client details for the consent screen.
 *
 * better-auth's `mcp` plugin re-exports only a subset of the OIDC provider's endpoints
 * (see `mcp/index.mjs`) and `getOAuthClient` is NOT among them, so its own
 * `/oauth2/client/:id` route is never mounted — hence this handler. Deliberately outside
 * `/api/auth`, which `server/middleware/auth.ts` treats as a public prefix; under
 * `/api/oauth` the global guard applies and a session (or token) is required.
 */
export default defineEventHandler(async (event) => {
  const clientId = getRouterParam(event, 'clientId')
  if (!clientId) throw createError({ statusCode: 400, statusMessage: 'clientId is required' })

  const db = useDb()
  const [row] = await db
    .select({
      clientId: oauthApplication.clientId,
      name: oauthApplication.name,
      redirectUrls: oauthApplication.redirectUrls,
      disabled: oauthApplication.disabled
    })
    .from(oauthApplication)
    .where(eq(oauthApplication.clientId, clientId))
    .limit(1)

  if (!row) throw createError({ statusCode: 404, statusMessage: 'Unknown client' })

  return {
    clientId: row.clientId,
    displayName: clientDisplayName(row.name, row.clientId),
    redirectHosts: redirectHosts(row.redirectUrls),
    disabled: row.disabled ?? false
  }
})
