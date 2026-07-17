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

/**
 * True when an OAuth access token's expiry is still ahead of `now`.
 *
 * better-auth's `getMcpSession` handler (`node_modules/better-auth/dist/plugins/mcp/index.mjs`,
 * the `/mcp/get-session` endpoint) looks the access token up by value and returns the raw
 * `oauth_access_token` row unconditionally — it never checks `accessTokenExpiresAt`. This
 * predicate is the actual expiry enforcement point, applied in `server/middleware/auth.ts`
 * after calling `getMcpSession`. The boundary is exclusive: a token whose expiry exactly
 * equals `now` is treated as already expired.
 */
export function isOauthTokenLive(expiresAt: Date | string, now: number = Date.now()): boolean {
  const expiresAtMs = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime()
  return expiresAtMs > now
}
