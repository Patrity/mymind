---
title: API Tokens & Connect to Claude Code
status: shipped
cycle: 13
phase: 1
updated: 2026-06-15
---

# API Tokens & Connect to Claude Code

How machine clients authenticate to MyMind, how to mint/revoke their tokens, and how to wire Claude Code (MCP + session-logging hooks) to a fresh token. Shipped in cycle 13 phase 1.

## Token model

`api_tokens` (`server/db/schema/api-tokens.ts`): `id`, `name`, `token_hash` (sha256 hex, unique), `last_four` (non-secret display hint — last 4 chars of the minted token; **null** for legacy hand-inserted rows, which render as `mm_…????`), `last_used_at`, `created_at`, `revoked_at`.

Tokens are `mm_<base64url>` (`generateToken()`), stored only as their sha256 hash. The plaintext is shown **once** at mint and never persisted or logged.

## Auth (`server/middleware/auth.ts`)

`/api/**` is gated by dual auth: a `Authorization: Bearer <token>` header (machine clients) is looked up by hash where `revoked_at IS NULL` → sets `event.context.client = { type:'api-token', tokenId }` and bumps `last_used_at` fire-and-forget; otherwise a better-auth session → `{ type:'session', userId }`. No match → 401. Public prefixes (no auth): `/api/auth`, `/api/share`, `/api/i`, `/api/setup`.

## Management (service `server/services/api-tokens.ts`, endpoints `server/api/settings/tokens/`)

- `GET /api/settings/tokens` → list (DTO: `id,name,lastFour,createdAt,lastUsedAt,revokedAt` — never the hash).
- `POST /api/settings/tokens` `{name}` → mint; returns the DTO **plus the one-time plaintext `token`**.
- `POST /api/settings/tokens/[id]/revoke` → soft-revoke (`revoked_at`, row kept; idempotent; 404 unknown).

All three require a **session** (`requireSession`, `server/utils/auth-guard.ts`) — a valid bearer/api-token client gets **403**, so a leaked machine token can't mint/list/revoke. Mutations `publishChange({ resource:'apiToken', … })` → the list is live across tabs (query key `['apiToken','list']`).

## UI

`/settings → API Keys` tab (`app/components/settings/ApiKeysTab.vue`, composable `useApiTokens`): token list (name · `mm_…lastFour` · created · last-used · Active/Revoked · revoke), a create modal that reveals the plaintext once in a dismissible warning alert with copy, and the **Connect to Claude Code** section.

## Connect to Claude Code

The token lives in two env vars so the snippets carry no secret: `MYMIND_URL`, `MYMIND_TOKEN` (the UI uses `window.location.origin` for the URL).

- **MCP**: `.mcp.json`/`~/.claude.json` `{ "mcpServers": { "mymind": { "type":"http", "url":"${MYMIND_URL}/api/mcp", "headers": { "Authorization":"Bearer ${MYMIND_TOKEN}" } } } }`, or `claude mcp add --transport http --scope user --header "Authorization: Bearer ${MYMIND_TOKEN}" mymind "${MYMIND_URL}/api/mcp"`.
- **Hooks**: `curl -fsSL "$MYMIND_URL/api/setup/cc-hook" -o ~/.mymind/cc-hook.sh && chmod +x …`, then a `~/.claude/settings.json` `hooks` block wiring `~/.mymind/cc-hook.sh <Event>` on `SessionStart`/`UserPromptSubmit`/`Stop`/`SubagentStop`/`SessionEnd`.

### The hook client (`GET /api/setup/cc-hook`, source `server/assets/setup/cc-hook.sh`)

Served public (non-secret) as a Nitro server asset (`nitro.serverAssets` baseName `setup` → `useStorage('assets:setup')`; the serve endpoint coerces the asset to a utf-8 string). The script: reads `MYMIND_URL`/`MYMIND_TOKEN` from env or `~/.mymind/config.env`; silently no-ops (exit 0) if unconfigured; keeps a stable machine id; on each event POSTs `{source,external_id,project,cwd,git_*,machine_id,hostname,metadata}` to `/api/hooks/cc/<event>`; on `Stop`/`SubagentStop`/`SessionEnd` ships the transcript **byte-offset delta** (`~/.mymind/transcript-offsets/`, 4 MB cap, advance only to the last whole line, advance the offset only on HTTP 2xx) to `/api/hooks/cc/transcript`. Always exits 0 so it never blocks the agent.

> Note (phase 1): the `/api/hooks/cc/[event]` handler currently ignores the top-level `git_*`/`machine_id`/`hostname`/`app_version` fields (non-strict zod strips them). Persisting them (+ tool events, thinking, sidechain) is **cycle 13 phase 2** (capture fidelity); the script already sends them so it won't need reinstalling.

## Validated (2026-06-15, dev server)

Mint via UI → one-time reveal; bearer → protected route 200 + MCP `tools/list` 200; bearer → `/api/settings/tokens` **403**; revoke via UI → row Revoked + bearer **401**. `GET /api/setup/cc-hook` → 200 shellscript. Static gates green (typecheck 0 / test 259 / build).
