import { oAuthProtectedResourceMetadata } from 'better-auth/plugins'
import { useAuth } from '../../utils/auth'

// RFC 9728 protected-resource metadata. Claude probes both the bare path and
// the /api/mcp-suffixed variant; serve the same document from both.
export default defineEventHandler((event) =>
  oAuthProtectedResourceMetadata(useAuth())(toWebRequest(event))
)
