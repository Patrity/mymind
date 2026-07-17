---
title: MCP OAuth — claude.ai custom connector support via better-auth mcp plugin
date: 2026-07-17
status: draft
supersedes: []
related:
  - server/api/mcp/index.post.ts
  - server/middleware/auth.ts
  - server/utils/auth.ts
  - server/services/api-tokens.ts
  - docs/wiki/mcp.md
---

# MCP OAuth — claude.ai custom connector support

## Problem

MyMind's MCP server (`POST /api/mcp`, Streamable HTTP, stateless) authenticates
with static `mm_` bearer tokens or a web session. claude.ai / Claude Desktop
custom connectors cannot send a static bearer token — the request-headers beta
is not rolled out to Tony's account (confirmed 2026-07-16, screenshot) — so the
only viable path is the OAuth flow Claude's connector dialog is built around:

- discovery via RFC 9728 protected-resource metadata + RFC 8414
  authorization-server metadata,
- OAuth 2.0 authorization-code flow with PKCE S256,
- dynamic client registration (RFC 7591), and
- token refresh.

Our middleware today returns a bare 401 with no `WWW-Authenticate` discovery
pointer, and no OAuth endpoints exist.

## Decision

Use the **better-auth `mcp` plugin** (better-auth ≥ 1.6.13, already the app's
session layer) as the OAuth 2.1 provider, rather than hand-rolling the five
protocol endpoints or deploying an external IdP. Rationale: the protocol-
critical, security-critical code (authorize, token exchange, PKCE, DCR, refresh
rotation, consent records) stays in maintained upstream code we already trust
with sessions; what we author shrinks to seams. An external IdP (Pocket ID /
Keycloak) remains a separate future decision this does not preclude — the
protected-resource metadata can be re-pointed at one later.

**Client scope decision (Tony, 2026-07-16): open dynamic client registration.**
Any MCP client (Claude surfaces, Claude Code OAuth, MCP Inspector, future
assistants) may register and initiate a flow. The gate is the consent screen,
which only renders for a logged-in MyMind session and is **never
auto-approved**.

## Architecture

```
Claude cloud (160.79.104.0/21)                     Tony's browser
      │                                                  │
      │ POST /api/mcp (Bearer)                           │ /login → /oauth/consent
      ▼                                                  ▼
┌─ Pangolin (unprotected edge, public https) ──────────────────────┐
│                                                                  │
│  server/routes/.well-known/*  ← NEW: metadata (public, no /api)  │
│  /api/auth/** (public prefix) ← better-auth handler              │
│     └─ mcp plugin: oauth2/authorize, token, register, consent    │
│  /api/mcp                     ← middleware branch: mm_ | OAuth   │
└──────────────────────────────────────────────────────────────────┘
```

Server-to-server calls (discovery, token, MCP) come from Anthropic's egress
range; the authorize/consent leg runs in Tony's browser. Both pass the
unprotected Pangolin edge; the app enforces all auth. **Precondition:** no
CrowdSec/geo/IP-reputation rule on the edge may block `160.79.104.0/21`.

## Components

### 1. Plugin registration — `server/utils/auth.ts`

Add to the existing `betterAuth({...})` config:

```ts
plugins: [
  mcp({
    loginPage: '/login',
    resource: `${baseURL}/api/mcp`,
    oidcConfig: {
      allowDynamicClientRegistration: true,
      requirePKCE: true,
      // access token 1h (default), auth code 10min (default)
      refreshTokenExpiresIn: 60 * 60 * 24 * 30 // 30d, up from 7d default:
      // an unused connector should not force re-consent weekly
    }
  })
]
```

Default scopes are kept (includes `offline_access` → refresh tokens flow).
All plugin endpoints mount under `/api/auth/*`, which is already in the
middleware's `PUBLIC_PREFIXES`.

### 2. Well-known routes — `server/routes/.well-known/` (NEW dir)

Root-level Nitro routes, automatically outside the `/api/**` auth guard:

| Route file | Serves |
|---|---|
| `oauth-authorization-server.get.ts` | `oAuthDiscoveryMetadata(useAuth())` — RFC 8414 doc; must advertise `code_challenge_methods_supported: ["S256"]` |
| `oauth-protected-resource.get.ts` | `getMCPProtectedResourceMetadata` — RFC 9728 doc |
| `oauth-protected-resource/api/mcp.get.ts` | same doc (Claude probes the path-suffixed variant first) |

Hard requirement: the `resource` field must byte-match the URL entered in
Claude's dialog — prod: `https://brain.costanzoclan.com/api/mcp` — and
`authorization_servers[0]` must be the public https issuer. Both derive from
`BETTER_AUTH_URL` so dev works unchanged; never a LAN/http URL — watch
`x-forwarded-proto` behind Pangolin.

### 3. Middleware branch — `server/middleware/auth.ts`

On `/api/mcp` (and only there), a Bearer credential that fails the `mm_`
`api_tokens` lookup is retried as an OAuth access token via
`useAuth().api.getMcpSession({ headers })`. Outcomes:

- valid OAuth token → `event.context.client = { type: 'oauth', tokenId, userId }`
- invalid/absent → `401` with `WWW-Authenticate: Bearer resource_metadata=
  "<BETTER_AUTH_URL>/.well-known/oauth-protected-resource"`

Existing behavior for `mm_` tokens, web sessions, and all other `/api` routes
is unchanged (other routes keep the bare `WWW-Authenticate: Bearer` header).

### 4. Data model — migration 0029

Three better-auth-managed tables added to `server/db/schema/auth.ts` in the
existing style: `oauthApplication` (DCR clients), `oauthAccessToken`
(access + refresh tokens), `oauthConsent` (consent records). Generated
per the better-auth mcp/oidc-provider schema reference; no changes to
`api_tokens`.

### 5. Consent page — `app/pages/oauth/consent.vue` (NEW)

Session-gated page (unauthenticated visits bounce through `/login`):

1. Reads `consent_code` + client metadata from the query string.
2. Renders client name and requested scopes, Approve / Deny.
3. POSTs `{ accept, consent_code }` to `/api/auth/oauth2/consent`.
4. Redirects the browser to the returned `redirectURI`.

Configured via `oidcConfig.consentPage`. **Never auto-approve**, even though
the system is single-user: anyone on the internet can *initiate* a flow by
adding our URL as a connector in their own Claude account; the explicit
approve click on Tony's session is the control that keeps a stray flow
visible and dead.

Verification item: `login.vue` must honor the post-login redirect parameter
better-auth appends when bouncing an unauthenticated authorize request. If it
doesn't, add it (small change).

## Error handling

- Protocol errors (bad code, PKCE mismatch, expired refresh token →
  `invalid_grant`, malformed DCR) are better-auth's responsibility; we don't
  wrap or re-map them.
- `/token` accepts `application/x-www-form-urlencoded` (better-auth handles).
- Claude-side timeouts: discovery/registration/token 10 s, refresh 30 s — all
  endpoints are local DB lookups, far under budget; no additional work.
- Middleware OAuth lookup failures are indistinguishable from bad tokens by
  design (single 401 shape with the resource_metadata pointer).

## Security posture

| Surface | Control |
|---|---|
| `/register` open write endpoint | consent gate + PKCE; rows are inert without an approved consent. Follow-up (deferred): cleanup cron for stale DCR rows in `server/tasks/` style |
| `/token` unauthenticated | one-time 10-min codes, PKCE S256 required, tokens hashed by better-auth |
| Consent | only renders on Tony's logged-in session; explicit approve; never auto |
| Access tokens | 1 h expiry + refresh rotation (better-auth); loss of a token is time-boxed |
| Revocation | disconnect in Claude, or delete the consent/token rows; (existing `mm_` tokens unaffected, still managed in Settings → API tokens) |

## Testing

1. **Unit** (vitest): well-known routes return required fields
   (`resource` exact match, `code_challenge_methods_supported: ["S256"]`,
   `authorization_servers`); middleware branch — `mm_` token still works,
   OAuth token works, garbage returns 401 with the `resource_metadata` header.
2. **Local E2E**: MCP Inspector's OAuth flow against dev; playwright-cli
   through login → consent → redirect (per browser-testing skill).
3. **Prod verification** (the real gate): deploy, add
   `https://brain.costanzoclan.com/api/mcp` as a custom connector on
   claude.ai (no client id/secret — DCR), approve consent, confirm tool
   listing + a tool call.
   Then verify token refresh survives >1 h session.

## Out of scope

- Homelab-wide IdP / SSO (separate decision; re-point metadata later if ever).
- Request-headers auth path (Claude-side beta not available to this account).
- DCR cleanup cron (follow-up task).
- Surfacing OAuth tokens in the Settings → API tokens UI.

## Rollout

Own branch + cycle (brainstorm ✓ → spec ✓ → plan → build → handover), then
prod deploy per the prod-deploy skill. Wiki: update `docs/wiki/mcp.md` (or
create if absent) in the same change. MyMind task e428fe7b tracks the front.
