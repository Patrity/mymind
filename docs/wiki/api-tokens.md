---
title: API Tokens & Connect
status: shipped
cycle: 13
phase: 1
updated: 2026-06-16
---

# API Tokens & Connect

How machine clients authenticate to MyMind, how to mint/revoke their tokens, and how to wire up the two client integrations: **Claude Code** (MCP + session-logging hooks, macOS/Linux **and** Windows) and **Screenshots** (ShareX/CleanShot custom uploader). Shipped in cycle 13 phase 1; Windows + Screenshots added 2026-06-16.

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

`/settings/api-keys` (`app/components/settings/ApiKeysTab.vue`, composable `useApiTokens`): token list (name · `mm_…lastFour` · created · last-used · Active/Revoked · revoke), a create modal that reveals the plaintext once in a dismissible warning alert with copy, and the **Connect** section.

## Connect

A nested `UTabs` with two tabs — **Claude Code** (with a macOS/Linux ⇄ Windows `UTabs` toggle, `:content="false"`, bound to an `os` ref) and **Screenshots**. The token lives in two env vars so the snippets carry no secret beyond the token itself: `MYMIND_URL`, `MYMIND_TOKEN` (the UI uses `window.location.origin` for the URL). The `settings.json` hooks block is built via `JSON.stringify` from a per-OS command builder (guarantees correct escaping of Windows backslash paths).

### Claude Code
- **MCP** (OS-independent — Claude Code expands `${ENV}` in MCP config): `.mcp.json`/`~/.claude.json` `{ "mcpServers": { "mymind": { "type":"http", "url":"${MYMIND_URL}/api/mcp", "headers": { "Authorization":"Bearer ${MYMIND_TOKEN}" } } } }`, or the CLI `claude mcp add --transport http --scope user mymind "${MYMIND_URL}/api/mcp" --header "Authorization: Bearer ${MYMIND_TOKEN}"`. **Name + URL must precede `--header`** — `--header` is variadic and otherwise swallows the positionals (`missing required argument 'name'`).
- **Hooks (macOS/Linux)**: `mkdir -p ~/.mymind && curl -fsSL "$MYMIND_URL/api/setup/cc-hook" -o ~/.mymind/cc-hook.sh && chmod +x …` (the `mkdir` makes the install self-contained), then a `~/.claude/settings.json` `hooks` block wiring `~/.mymind/cc-hook.sh <Event>`.
- **Hooks (Windows)**: `Invoke-WebRequest "$env:MYMIND_URL/api/setup/cc-hook.ps1" -OutFile "$HOME\.mymind\cc-hook.ps1"`, then a `%USERPROFILE%\.claude\settings.json` block wiring `powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.mymind\cc-hook.ps1" <Event>`. (Running CC under WSL → use the macOS/Linux tab.)
- **Events wired** (7, both OSes): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd`. Only the transcript carries message/tool **data**; `PreToolUse`/`PostToolUse` are liveness ticks (see [[bridget-hooks-liveness-only]] reasoning in `sessions.md`). `PostToolUseFailure` is intentionally omitted (not a real CC event).

### Screenshots (ShareX / CleanShot X)
A generated **`.sxcu`** custom-uploader (token embedded; Download button writes it client-side via a Blob): `POST ${MYMIND_URL}/api/upload?public=1`, `MultipartFormData`, file form-field `file`, `Authorization: Bearer …`, response URL parsed from `{json:url}`. The same file imports into both ShareX (Destinations → Custom uploader settings → Import) and CleanShot X (Settings → Uploads → Custom). Uploads land in the [image hosting](image-hosting.md) pipeline (public link + OCR/enrich + searchable gallery).

### The hook clients (`GET /api/setup/cc-hook` + `/api/setup/cc-hook.ps1`)

Both served public (non-secret) as Nitro server assets (`nitro.serverAssets` baseName `setup` → `useStorage('assets:setup')`; the serve endpoints coerce the asset to a utf-8 string, `text/x-shellscript` for `.sh`, `text/plain` for `.ps1`). Each script (bash `cc-hook.sh` / PowerShell `cc-hook.ps1`): reads `MYMIND_URL`/`MYMIND_TOKEN` from env or `~/.mymind/config.env`; silently no-ops (exit 0) if unconfigured; keeps a stable machine id; on each event POSTs `{source,external_id,project,cwd,git_*,machine_id,hostname,metadata}` to `/api/hooks/cc/<event>` (persisted as session liveness + git/machine metadata, cycle 13 phase 2); on `Stop`/`SubagentStop`/`SessionEnd` ships the transcript **byte-offset delta** (`~/.mymind/transcript-offsets/`, 4 MB cap, advance only to the last whole line, advance the offset only on HTTP 2xx) to `/api/hooks/cc/transcript`. Always exits 0 so it never blocks the agent. (The PowerShell port POSTs synchronously with short timeouts — Windows PowerShell 5.1 has no cheap background dispatch — vs the bash version which backgrounds the POST.)

## Validated
- **2026-06-15** (dev): mint via UI → one-time reveal; bearer → protected route 200 + MCP `tools/list` 200; bearer → `/api/settings/tokens` **403**; revoke → Revoked + bearer **401**; `GET /api/setup/cc-hook` → 200.
- **2026-06-16** (dev, playwright-cli): both Connect sub-tabs render; OS toggle swaps bash↔PowerShell snippets; Screenshots tab renders the `.sxcu` + Download + ShareX/CleanShot instructions; `GET /api/setup/cc-hook` and `/api/setup/cc-hook.ps1` → 200; Windows hooks block parses as valid JSON. Gates green (typecheck 0 / test 315).
