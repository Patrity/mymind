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
 * Fix: for a GET to that exact path, enforce the CANONICAL value better-auth
 * checks for — pass through only when the query carries exactly one `prompt`
 * param whose value is exactly `consent`. Anything else (absent, `none`, a
 * case variant like `Consent`, a multi-value like `consent login`, or
 * duplicate `prompt` keys) 302-redirects to the same URL with all `prompt`
 * params replaced by a single `prompt=consent`. Presence alone is NOT enough:
 * better-auth's gate is the strict string comparison above, so e.g.
 * `prompt=none` or `prompt=consent&prompt=none` would pass a mere
 * has('prompt') check and still silently mint a code. Deliberate
 * non-conformance with RFC `prompt=none` semantics: better-auth 1.6.13
 * doesn't implement them anyway (it would silently mint instead of returning
 * `interaction_required`), so forcing consent is the safe behavior — our
 * spec's never-auto-approve rule wins over client prompt intent. The
 * redirect target always normalizes to exactly one `prompt=consent`, which
 * the pass-through branch accepts, so there is no redirect loop. When
 * `prompt` is absent entirely we append to the raw query string (other
 * params preserved byte-for-byte); when rewriting existing `prompt` values
 * we rebuild via URLSearchParams, which preserves every other param's
 * key/value but may normalize encoding — better-auth parses the query with
 * standard URL parsing, so param order/encoding normalization is safe.
 */

import type { H3Event } from 'h3'

const GUARDED_PATHNAME = '/api/auth/mcp/authorize'

/**
 * Pure decision function: given the request method, pathname, and raw query
 * string (H3/URL's `.search`, i.e. `''` or starting with `?`), returns the
 * pathname+query to redirect to when consent must be forced, or `null` when
 * the request should pass through untouched.
 *
 * Pass-through requires the canonical form: exactly one `prompt` param with
 * the exact value `consent` — mirroring better-auth's strict
 * `query.prompt === "consent"` gate, including its duplicate-key behavior
 * (duplicates parse to an array upstream, which never strict-equals the
 * string).
 */
export function decideConsentRedirect(method: string, pathname: string, search: string): string | null {
  if (method !== 'GET') return null
  if (pathname !== GUARDED_PATHNAME) return null
  const params = new URLSearchParams(search)
  const prompts = params.getAll('prompt')
  if (prompts.length === 1 && prompts[0] === 'consent') return null
  if (prompts.length === 0) {
    // Absent entirely: append to the raw string — other params byte-for-byte.
    return `${pathname}${search ? `${search}&prompt=consent` : '?prompt=consent'}`
  }
  // Non-canonical value(s) present: strip them all, set exactly one.
  params.delete('prompt')
  params.set('prompt', 'consent')
  return `${pathname}?${params.toString()}`
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
