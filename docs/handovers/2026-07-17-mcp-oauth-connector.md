---
title: MCP OAuth — claude.ai custom connector support (cycle 48)
cycle: 48
date: 2026-07-17
status: BUILT, E2E-verified locally (gates green — typecheck 0 / test 812 / build). NOT merged/pushed/deployed. AWAITING prod deploy + a real claude.ai connector add/approve/tool-call verification, which happens immediately after this handover (see "Next steps").
branch: feat/mcp-oauth (built subagent-driven in an isolated worktree, 7 plan tasks + 2 unplanned fix commits discovered during Task 6's E2E pass; per-task reports in `.superpowers/sdd/task-{1..7}-report.md`)
docs:
  - ../wiki/mcp.md (living reference — new "Authentication" section: two auth paths, better-auth `mcp` plugin config, well-known routes, the consent guard, consent page, migration 0029; cycle bumped 40→48)
  - ../superpowers/specs/2026-07-17-mcp-oauth-connector-design.md (spec)
  - ../superpowers/plans/2026-07-17-mcp-oauth-connector.md (plan)
  - ../superpowers/plans/00-roadmap.md (cycle-48 row still needs adding — out of this task's file scope, flagged under "Next steps")
related:
  - ../handovers/2026-06-30-agent-document-tools.md (the MCP tool surface this connector now exposes to claude.ai)
problem: >
  MyMind's MCP server (`POST /api/mcp`, Streamable HTTP, stateless) only accepted a static
  `mm_` bearer API token or a web session. claude.ai / Claude Desktop custom connectors
  cannot supply a static bearer header — Claude's request-headers beta that would allow
  this is not rolled out to Tony's account (confirmed 2026-07-16) — so the only viable
  integration path is the OAuth 2.1 flow Claude's connector dialog is built around:
  RFC 9728/8414 discovery, authorization-code + PKCE S256, dynamic client registration
  (RFC 7591), and refresh. The existing middleware returned a bare 401 with no
  `WWW-Authenticate` discovery pointer, and no OAuth endpoints existed.
keydecision: >
  Used the already-installed better-auth `mcp` plugin (better-auth 1.6.13) as the OAuth 2.1
  provider rather than hand-rolling the five protocol endpoints or standing up an external
  IdP — the protocol/security-critical code (authorize, token exchange, PKCE, DCR, refresh
  rotation, consent records) stays in maintained upstream code already trusted with
  sessions. Client registration is deliberately OPEN (any MCP client may self-register);
  the security boundary is the consent screen, which must never auto-approve. Task 6's E2E
  pass then surfaced a real gap NOT in the original plan: better-auth 1.6.13 only renders
  consent when the authorize request carries the exact query value `prompt=consent` — an
  authorize URL that simply omits `prompt` (the literal shape produced by the plan's own
  E2E script) silently mints a code with no consent screen. A follow-up Nitro middleware
  (`oauth-consent-guard.ts`) forces canonical `prompt=consent` on every `GET
  /api/auth/mcp/authorize`, then was hardened a second time after adversarial review found
  the first version's `has('prompt')` check still let `prompt=none`/case-variants/duplicate
  keys through — the fix now enforces the exact canonical value, closing that bypass too.
---

# MCP OAuth — claude.ai custom connector support (cycle 48)

## What shipped

- **better-auth `mcp` plugin registered** (`server/utils/auth.ts`) on the existing
  `betterAuth()` instance: open dynamic client registration, PKCE S256 required, consent
  page at `/oauth/consent`, 30-day refresh tokens (up from better-auth's 7-day default —
  an unused personal connector shouldn't force weekly re-consent), 1-hour access tokens
  (default, unchanged).
- **Three `.well-known` discovery routes** (`server/routes/.well-known/`, outside the
  `/api/**` auth guard so public by construction): RFC 8414 authorization-server metadata,
  RFC 9728 protected-resource metadata (both the bare path and the `/api/mcp`-suffixed
  variant Claude also probes).
- **Middleware OAuth branch** (`server/middleware/auth.ts`): on `/api/mcp` only, a bearer
  that fails the `mm_` `api_tokens` lookup is retried as a better-auth OAuth access token
  (`useAuth().api.getMcpSession`). Every 401 on `/api/mcp` now carries the RFC 9728
  `resource_metadata` challenge pointer; every other route keeps the bare
  `WWW-Authenticate: Bearer` it always had. `event.context.client` gained an `'oauth'`
  variant (`{ type: 'oauth', tokenId, userId }`).
- **Consent guard** (`server/middleware/oauth-consent-guard.ts`, NOT in the original plan
  — see `keydecision` above and "Adversarial finding" below). Forces exactly one
  canonical `prompt=consent` on every `GET /api/auth/mcp/authorize`, closing a silent-mint
  gap that would otherwise let a crafted authorize link skip the consent screen entirely.
  13 unit tests on the pure `decideConsentRedirect` decision function.
- **Consent page** (`app/pages/oauth/consent.vue`) — session-gated, shows client id +
  requested scopes, Approve/Deny, POSTs to `/api/auth/oauth2/consent`, redirects to the
  returned `redirectURI`. **Login bounce** (`app/pages/login.vue`) — on successful
  sign-in mid-OAuth-flow, resumes `/api/auth/mcp/authorize?<original query>` instead of
  routing to `/documents`.
- **Data model** — migration 0029: `oauth_application` (DCR clients), `oauth_access_token`
  (access + refresh tokens), `oauth_consent` (consent decisions), all in
  `server/db/schema/auth.ts` alongside the existing better-auth tables. `api_tokens` (the
  `mm_` token table) is untouched.
- **Scripted E2E harness** (`scripts/mcp-oauth-e2e.mjs`, committed for reuse): DCR register
  → build a PKCE authorize URL → (browser leg via playwright-cli for login/consent) →
  token exchange → authenticated `/api/mcp` call.
- **`useAuth()` return-type fix** (commit `0fe2b94`, folded into Task 4 as a scope
  amendment, already DONE — not deferred): `useAuth()` was erasing its return type to
  `Auth<BetterAuthOptions>` via an `any`-typed memo + cast, which dropped the `mcp`
  plugin's typed API surface (`getMcpOAuthConfig`, `getMCPProtectedResource`,
  `getMcpSession`) and had forced `as any` casts at the three well-known route call sites.
  Restructured into `buildAuth()` + a memo typed off `ReturnType<typeof buildAuth>` so the
  concrete plugin-augmented type flows through; all three route casts were then removed.

## Architecture / where things live

- `server/utils/auth.ts` — plugin registration (`mcp({...})`), `buildAuth()`/`useAuth()`.
- `server/utils/oauth-metadata.ts` — `oauthOrigin`, `mcpAuthChallengeHeader` (shared by the
  middleware and the well-known routes).
- `server/routes/.well-known/{oauth-authorization-server,oauth-protected-resource}.get.ts`,
  `server/routes/.well-known/oauth-protected-resource/api/mcp.get.ts`.
- `server/middleware/auth.ts` — the OAuth branch on `/api/mcp`.
- `server/middleware/oauth-consent-guard.ts` — the forced-consent redirect + colocated
  `decideConsentRedirect` pure function.
- `server/db/schema/auth.ts` + `server/db/migrations/0029_calm_lifeguard.sql`.
- `app/pages/oauth/consent.vue`, `app/pages/login.vue` (bounce branch only).
- `scripts/mcp-oauth-e2e.mjs`.
- Wiki: `docs/wiki/mcp.md` — new "Authentication" section covers all of the above in
  narrative form; read that for the day-to-day reference, this handover is the historical
  record.

## Verification

**Task 6 E2E** (`.superpowers/sdd/task-6-report.md`, `PORT=3100 pnpm dev` against a real
local Postgres): ran the full DCR → PKCE authorize → browser login/consent
(`playwright-cli`) → code capture → token exchange → authenticated `/api/mcp` call,
**three separate times** across the fix cycle:

1. Pre-guard baseline — proved DCR → login → PKCE → token → MCP call end-to-end, but also
   proved the consent screen was skippable (the adversarial finding that produced the
   guard).
2. Post-guard (first version) — the exact same request shape that skipped consent before
   now hits `/oauth/consent` and renders correctly; approve → token exchange →
   authenticated `/api/mcp` call still succeeds (`TOKEN_OK expires_in=3600 refresh=true`,
   `MCP_STATUS=200`, `MCP_HAS_TOOLS=true`).
3. Post-hardening spot-check — a `prompt=none` request (the specific bypass shape an
   adversarial review caught in the first guard version) is now also rewritten to
   `prompt=consent` and rendered the consent page; DB-verified `requireConsent:true` on
   the server side (not a client-side redirect artifact) for that flow.

Each run confirmed via direct DB inspection (`oauth_consent.consent_given: true`,
`verification.requireConsent`) that the server made the decision, not just the client
following a redirect. All test OAuth clients/tokens/consent rows were deleted from the
dev DB after each run; dev servers killed and confirmed down.

**Gates** (final committed state, per `task-6-report.md`'s hardening pass): `pnpm typecheck`
clean · `pnpm test` — 124 files / **812 tests** passed · `pnpm build` clean. Migration
0029 applies cleanly and touches no existing table.

## Deferred / fast-follows

- **DCR cleanup cron** — registration is open with no allowlist; nothing yet prunes stale
  `oauth_application` rows left by abandoned or exploratory registrations (rows are inert
  without an approved consent, so this is hygiene, not a security gap). Follow-up task.
- **Request-headers auth path** — Claude's beta that would let a header-capable client
  skip OAuth is not available on this account; revisit if/when it rolls out.
- **Consent page minor UX notes** (Task 5, non-blocking): the Approve/Deny buttons only
  set their own `loading` state (`loading === 'approve'` / `loading === 'deny'`) — they
  don't cross-disable each other, so a user could click the other button while the first
  click's `$fetch` is still in flight. Separately, an empty/missing `consent_code` isn't
  checked until a button is clicked (the POST goes out with an empty string and the
  resulting error is what surfaces) rather than failing fast on page load.
- **`prompt=none` override is deliberate non-conformance**, not a bug to fix later: RFC
  `prompt=none` means "don't show any interactive prompt, fail with `interaction_required`
  if one would be needed." better-auth 1.6.13 doesn't implement that semantic at all (it
  would silently mint a code instead), so the consent guard treats `prompt=none` the same
  as "absent" and forces consent anyway. Rationale is documented in the guard's file-level
  comment (`server/middleware/oauth-consent-guard.ts`) so a future reader doesn't mistake
  it for an oversight.
- **Not deferred** (already done, listed here so it isn't mistaken for outstanding work):
  the `useAuth()` return-type fix (see "What shipped" above) — it's the correct long-term
  typing, not a workaround left for later.

## Next steps (prod rollout — post-handover, driven by the orchestrating session)

1. Merge `feat/mcp-oauth` → `master`, push.
2. Deploy per the `prod-deploy` skill (native systemd, LXC 114).
3. `pnpm db:migrate` on prod (applies migration 0029 — three new tables, no existing-table
   changes, safe).
4. Verify against `https://brain.costanzoclan.com`:
   - `curl -s https://brain.costanzoclan.com/.well-known/oauth-authorization-server`
   - `curl -s https://brain.costanzoclan.com/.well-known/oauth-protected-resource`
   - `curl -s https://brain.costanzoclan.com/.well-known/oauth-protected-resource/api/mcp`
   - `curl -si -X POST https://brain.costanzoclan.com/api/mcp` → confirm `401` +
     `www-authenticate: Bearer resource_metadata="https://brain.costanzoclan.com/.well-known/oauth-protected-resource"`
5. On claude.ai: add a custom connector with URL `https://brain.costanzoclan.com/api/mcp`
   (no client id/secret — DCR handles it).
6. Approve the consent screen when redirected to Tony's logged-in session.
7. Confirm tools listing renders and a tool call succeeds through the real Claude UI.
8. Verify token refresh survives past the 1-hour access-token expiry (i.e. the connector
   keeps working in a session that outlives 1h, proving the refresh-token path works
   end-to-end against the real client, not just the scripted harness).
9. Add the cycle-48 row to `docs/superpowers/plans/00-roadmap.md` (out of this task's file
   scope, so not done here).
