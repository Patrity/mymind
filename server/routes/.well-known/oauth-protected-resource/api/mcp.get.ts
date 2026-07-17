import { oAuthProtectedResourceMetadata } from 'better-auth/plugins'
import { useAuth } from '../../../../utils/auth'

// RFC 9728 protected-resource metadata. Claude probes both the bare path and
// the /api/mcp-suffixed variant; serve the same document from both.
export default defineEventHandler((event) => {
  // useAuth()'s memoized return type is widened to the generic `Auth<BetterAuthOptions>`
  // (see task-3-report.md), which drops the mcp-plugin-specific `getMCPProtectedResource`
  // this helper requires at the type level; the plugin is registered at runtime regardless.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return oAuthProtectedResourceMetadata(useAuth() as any)(toWebRequest(event))
})
