import { oAuthDiscoveryMetadata } from 'better-auth/plugins'
import { useAuth } from '../../utils/auth'

// RFC 8414 authorization-server metadata, served at the origin root where
// MCP clients (Claude) probe for it. Delegates to better-auth so the
// advertised endpoints always match the plugin's real routes.
export default defineEventHandler((event) => {
  // useAuth()'s memoized return type is widened to the generic `Auth<BetterAuthOptions>`
  // (see task-3-report.md), which drops the mcp-plugin-specific `getMcpOAuthConfig` this
  // helper requires at the type level; the plugin is registered at runtime regardless.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return oAuthDiscoveryMetadata(useAuth() as any)(toWebRequest(event))
})
