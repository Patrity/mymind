---
title: Auth
status: shipped
cycle: 1
updated: 2026-08-25
---

# Auth

Two surfaces, enforced by one server middleware.

## Session (web app) — `server/utils/auth.ts`
better-auth with email/password, backed by Postgres via the Drizzle adapter. Standard tables `user` / `session` / `account` / `verification` (hand-written in `server/db/schema/auth.ts` — the better-auth CLI generator crashes on Nuxt auto-imports). Handler mounted at `server/api/auth/[...all].ts`. Single user (Tony). `trustedOrigins: ['http://localhost:3000']`.

## Sign-up gate — `ALLOW_SIGNUP`
Self-registration is **disabled by default** (`disableSignUp: cfg.allowSignup !== 'true'`) so the public can't register into the shared corpus. Set `ALLOW_SIGNUP=true` to bootstrap the first account, then unset it. The same env value is mirrored to `runtimeConfig.public.allowSignup` (boolean); when true, `/login` surfaces a "Create account" toggle that flips the form to register mode (adds a Name field, calls `authClient.signUp.email`, auto-signs-in and redirects to `/documents`). When the flag is off the toggle is hidden **and** the API rejects sign-up — UI and server gate stay in lockstep. Origin note: the sign-up endpoint enforces `trustedOrigins`, so test on the `BETTER_AUTH_URL` port (3000), not an alternative port.

## API tokens (machine clients) — `server/db/schema/api-tokens.ts`, `server/utils/api-token.ts`
`api_tokens`: `id`, `name`, `token_hash` (sha256, unique), `last_used_at`, `created_at`, `revoked_at`. `generateToken()` → `mm_` + base64url(24 bytes); only the sha256 hash is stored. For ShareX/CleanShot, Claude Code/Hermes hooks, MCP. Managed from `/settings/api-keys` (cycle 13) — create shows the plaintext once, list is masked, revoke is soft via `revoked_at`.

## Route guard (browser) — `app/middleware/auth.global.ts`
Client-side only (the app is `ssr: false`, so there is no server pass). Lets `/login` and `/share/**` through untouched; everything else needs a better-auth session or it bounces to the login page. Since 2026-08-25 the bounce **preserves the intended route**: the guard sends `/login?redirect=<to.fullPath>` (query + hash included; a request for `/` stays a bare `/login`), and `login.vue` consumes it on success through `safeRedirect()` (`app/lib/auth-redirect.ts`). That helper is the open-redirect gate — it accepts only a rooted single-slash internal path, rejecting `//host`, `/\host`, absolute URLs, control characters, and `/login` itself (which would loop the form); anything rejected falls back to `/`. The mid-OAuth branch (`client_id` + `response_type`, see [mcp](mcp.md)) is checked first and is unaffected.

## Middleware (API) — `server/middleware/auth.ts`
Runs for `/api/**` only (segment-precise: `/api/` or exactly `/api`). Exempts `/api/auth/**`, `/api/share/**`, `/api/i/**`, `/api/setup/**`, `/api/health`, and (since 2026-08-18) `/api/public/**` — the home for read-only, curated, internet-visible endpoints such as `/api/public/rig` (see [analytics](analytics.md)) — all exact-segment matches. Order: bearer token first (sha256 lookup, must be non-revoked; an invalid bearer 401s immediately — no fallthrough), else session via `getSession({ headers })`, else 401. Sets `event.context.user` / `event.context.client`. 401s carry `WWW-Authenticate: Bearer` (set via `setResponseHeader` — h3 v1.15 `createError` has no `headers` field). `lastUsedAt` updated fire-and-forget (`.execute().catch()`).

## Surface note
Internet-exposed: rate-limit auth and (future) upload endpoints; public share is read-only by slug. Secrets live in `.env` (gitignored) — never commit.
