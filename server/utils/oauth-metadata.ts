/** Origin (scheme+host) of the public deployment, from BETTER_AUTH_URL. */
export function oauthOrigin(betterAuthUrl: string | undefined): string {
  if (!betterAuthUrl) return 'http://localhost:3000'
  return new URL(betterAuthUrl).origin
}

/**
 * RFC 9728 challenge for 401s on /api/mcp — Claude reads this header to
 * discover the protected-resource metadata and start its OAuth flow.
 */
export function mcpAuthChallengeHeader(origin: string): string {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
}
