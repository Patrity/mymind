import { oAuthDiscoveryMetadata } from 'better-auth/plugins'
import { useAuth } from '../../utils/auth'

// RFC 8414 authorization-server metadata, served at the origin root where
// MCP clients (Claude) probe for it. Delegates to better-auth so the
// advertised endpoints always match the plugin's real routes.
export default defineEventHandler((event) =>
  oAuthDiscoveryMetadata(useAuth())(toWebRequest(event))
)
