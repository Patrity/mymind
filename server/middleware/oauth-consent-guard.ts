/**
 * better-auth's `mcp` plugin only routes an authorize request through the
 * consent page when the request carries the literal query param
 * `prompt=consent` (see `authorizeMCPOAuth` in
 * `better-auth/dist/plugins/mcp/authorize.mjs`): `requireConsent:
 * query.prompt === "consent"`. There is no server-side "already consented,
 * skip" check and no OIDCOptions knob to force consent for all/untrusted
 * clients (checked `oidc-provider/types.d.mts` — only a per-trusted-client
 * `skipConsent` opt-out exists, which doesn't apply here since we register
 * no `trustedClients`). Without `prompt=consent`, a logged-in user's browser
 * silently mints an authorization code — no consent screen — so a crafted
 * authorize URL that simply omits `prompt` can hijack a connection to an
 * attacker's own account. Our spec (2026-07-17-mcp-oauth-connector-design.md,
 * "Security posture") mandates consent is never auto-approved.
 *
 * Only `GET /api/auth/mcp/authorize` is mounted by our config — the `mcp`
 * plugin defines its own `mcpOAuthAuthorize` endpoint at `/mcp/authorize`
 * (mounted under `basePath` `/api/auth`) rather than reusing the generic
 * oidc-provider's `/oauth2/authorize`; only `/oauth2/consent` is re-exported
 * from the internal oidc-provider instance. So `/api/auth/oauth2/authorize`
 * is never routed and needs no guard (confirmed by reading
 * `plugins/mcp/index.mjs`, which only spreads `oAuthConsent` from the
 * provider's endpoints, plus `dist/api/index.mjs`, which mounts each plugin
 * endpoint at its own baked-in `path`).
 *
 * Fix: for a GET to that exact path with no `prompt` query param at all,
 * 302-redirect to the same URL with `prompt=consent` appended, preserving
 * every other query param byte-for-byte (we never re-encode the original
 * query string — only append to it). An explicit `prompt` value (including
 * `prompt=none`, which a real client may legitimately send) is left alone —
 * this only forces the *missing* case, so there is no redirect loop and no
 * overriding of client intent.
 */

import type { H3Event } from 'h3'

const GUARDED_PATHNAME = '/api/auth/mcp/authorize'

/**
 * Pure decision function: given the request method, pathname, and raw query
 * string (H3/URL's `.search`, i.e. `''` or starting with `?`), returns the
 * pathname+query to redirect to when consent must be forced, or `null` when
 * the request should pass through untouched.
 */
export function decideConsentRedirect(method: string, pathname: string, search: string): string | null {
  if (method !== 'GET') return null
  if (pathname !== GUARDED_PATHNAME) return null
  if (new URLSearchParams(search).has('prompt')) return null
  const suffix = search ? `${search}&prompt=consent` : '?prompt=consent'
  return `${pathname}${suffix}`
}

function oauthConsentGuardHandler(event: H3Event) {
  const url = getRequestURL(event)
  const redirectTo = decideConsentRedirect(event.method, url.pathname, url.search)
  if (!redirectTo) return
  return sendRedirect(event, new URL(redirectTo, url.origin).toString(), 302)
}

// `defineEventHandler`/`getRequestURL`/`sendRedirect` are Nitro/h3 ambient
// globals available at real server runtime but not under plain vitest (no
// Nuxt test environment is wired into vitest.config.ts) — guard the default
// export so importing this file for `decideConsentRedirect`'s unit tests
// doesn't throw; production behavior is unaffected since the guard is
// always true under Nitro.
export default (typeof defineEventHandler === 'function'
  ? defineEventHandler(oauthConsentGuardHandler)
  : oauthConsentGuardHandler)
