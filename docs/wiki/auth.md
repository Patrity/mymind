---
title: Auth
status: shipped
cycle: 1
updated: 2026-06-03
---

# Auth

Two surfaces, enforced by one server middleware.

## Session (web app) — `server/utils/auth.ts`
better-auth with email/password, backed by Postgres via the Drizzle adapter. Standard tables `user` / `session` / `account` / `verification` (hand-written in `server/db/schema/auth.ts` — the better-auth CLI generator crashes on Nuxt auto-imports). Handler mounted at `server/api/auth/[...all].ts`. Single user (Tony). `trustedOrigins: ['http://localhost:3000']`.

## Sign-up gate — `ALLOW_SIGNUP`
Self-registration is **disabled by default** (`disableSignUp: cfg.allowSignup !== 'true'`) so the public can't register into the shared corpus. Set `ALLOW_SIGNUP=true` to bootstrap the first account, then unset it. The same env value is mirrored to `runtimeConfig.public.allowSignup` (boolean); when true, `/login` surfaces a "Create account" toggle that flips the form to register mode (adds a Name field, calls `authClient.signUp.email`, auto-signs-in and redirects to `/documents`). When the flag is off the toggle is hidden **and** the API rejects sign-up — UI and server gate stay in lockstep. Origin note: the sign-up endpoint enforces `trustedOrigins`, so test on the `BETTER_AUTH_URL` port (3000), not an alternative port.

## API tokens (machine clients) — `server/db/schema/api-tokens.ts`, `server/utils/api-token.ts`
`api_tokens`: `id`, `name`, `token_hash` (sha256, unique), `last_used_at`, `created_at`, `revoked_at`. `generateToken()` → `mm_` + base64url(24 bytes); only the sha256 hash is stored. For ShareX/CleanShot, Claude Code/Hermes hooks, MCP. (No management UI yet — insert rows directly; CRUD page is a later cycle.)

## Middleware — `server/middleware/auth.ts`
Runs for `/api/**` only (segment-precise: `/api/` or exactly `/api`). Exempts `/api/auth/**` and `/api/share/**` (exact-segment match). Order: bearer token first (sha256 lookup, must be non-revoked; an invalid bearer 401s immediately — no fallthrough), else session via `getSession({ headers })`, else 401. Sets `event.context.user` / `event.context.client`. 401s carry `WWW-Authenticate: Bearer` (set via `setResponseHeader` — h3 v1.15 `createError` has no `headers` field). `lastUsedAt` updated fire-and-forget (`.execute().catch()`).

## Surface note
Internet-exposed: rate-limit auth and (future) upload endpoints; public share is read-only by slug. Secrets live in `.env` (gitignored) — never commit.
