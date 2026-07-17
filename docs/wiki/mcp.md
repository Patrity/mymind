---
title: MCP Server
status: shipped
cycle: 48
updated: 2026-07-17
---

# MCP Server

Exposes MyMind to agents (Claude Code, etc.) over the Model Context Protocol, deprecating bridget's FastMCP server.

## Endpoint
`POST /api/mcp` — `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` in **stateless** mode (fresh `McpServer` + transport per request; no session store). Wired into the Nitro h3 handler (`server/api/mcp/index.post.ts`): reads the body, `server.connect(transport)`, `transport.handleRequest(event.node.req, event.node.res, body)`, then `event._handled = true` (h3 v1). Responses are SSE-framed JSON-RPC (clients send `Accept: application/json, text/event-stream`).

## Authentication

`/api/**` is gated by a single global middleware (`server/middleware/auth.ts`) that supports two independent client paths — pick based on what the client can do:

1. **`mm_` bearer API token** — machine clients that can set a static header (Claude Code, scripts, MCP Inspector with a manual token). Checked first against `api_tokens`. Mint/manage tokens and get a copy-paste MCP config at `/settings/api-keys` — see [`api-tokens.md`](api-tokens.md). Unaffected by everything below; `api_tokens` is a separate table from the OAuth tables.
2. **OAuth 2.1 (cycle 48)** — clients that only support a connector's browser-driven OAuth flow (claude.ai / Claude Desktop custom connectors). This is the only viable path for those surfaces: Claude's request-headers beta, which would let a header-capable client skip OAuth, is not available on this account.

On `/api/mcp` specifically, a bearer that fails the `mm_` lookup is retried as an OAuth access token (`useAuth().api.getMcpSession({ headers })`); elsewhere a failed `mm_` lookup goes straight to a session check, then 401. A 401 on `/api/mcp` carries the RFC 9728 discovery pointer — `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"` — so Claude can bootstrap OAuth discovery from a bare 401; every other route keeps the plain `WWW-Authenticate: Bearer` (unchanged).

### OAuth provider — better-auth `mcp` plugin

`server/utils/auth.ts` registers better-auth's `mcp` plugin (better-auth ≥ 1.6.13) on the app's existing `betterAuth()` instance — the same instance backing web-session login, not a separate IdP:

- **Open dynamic client registration** (RFC 7591, `allowDynamicClientRegistration: true`) — any client may self-register (`POST /api/auth/mcp/register`). The security boundary is the consent screen below, not the registration gate (deliberate: Claude Code OAuth, MCP Inspector, and future assistants should all be able to register without a manual allowlist step).
- **PKCE S256 required** (`requirePKCE: true`) on every authorize/token exchange.
- **Consent page** `/oauth/consent` (`oidcConfig.consentPage`).
- **Refresh tokens**: 30 days (`refreshTokenExpiresIn: 60*60*24*30`, up from better-auth's 7-day default — an unused personal connector shouldn't force weekly re-consent). Access tokens stay at better-auth's 1-hour default.
- **`resource`** is `<origin of BETTER_AUTH_URL>/api/mcp` — must byte-match the connector URL entered in Claude's dialog.

Plugin endpoints mount under the already-public `/api/auth/*` prefix: `GET /api/auth/mcp/authorize`, `POST /api/auth/mcp/token`, `POST /api/auth/mcp/register`, `POST /api/auth/oauth2/consent`. (The generic OIDC-provider's own `/oauth2/authorize` is never mounted by this plugin config — only `mcp/authorize` is a live route; see the consent-guard note below for why that distinction matters.)

### Discovery — `.well-known` routes

Three root-level Nitro routes under `server/routes/.well-known/` — outside the `/api/**` guard, so public with no auth, exactly as RFC 8414/9728 require:

| Route | Serves |
|---|---|
| `oauth-authorization-server.get.ts` | RFC 8414 authorization-server metadata (`oAuthDiscoveryMetadata`) — issuer, the four endpoints above, `code_challenge_methods_supported: ["S256"]` |
| `oauth-protected-resource.get.ts` | RFC 9728 protected-resource metadata (`oAuthProtectedResourceMetadata`) — `resource`, `authorization_servers` |
| `oauth-protected-resource/api/mcp.get.ts` | Same RFC 9728 doc, served at the `/api/mcp`-suffixed path Claude also probes |

### Consent — forced on every authorize (`server/middleware/oauth-consent-guard.ts`)

better-auth 1.6.13's `mcp` plugin only shows the consent page when the authorize request carries the *exact* query value `prompt=consent` (`requireConsent: query.prompt === "consent"`, read directly from its `authorize.mjs`). There is no "already consented, skip" check in this code path, and no `OIDCOptions` knob to force consent server-wide — the only consent-adjacent option, a per-client `skipConsent` inside `trustedClients`, is an opt-out we don't configure. Left as better-auth ships it, an authorize request that simply omits `prompt` — or sends a near-miss like `prompt=none`, a case variant, a multi-value, or a duplicate key — silently mints a code with **no consent screen shown**, which would let a crafted link hijack a connector install onto an attacker's own account.

To close that, a Nitro global middleware (`oauth-consent-guard.ts`) intercepts `GET /api/auth/mcp/authorize` — the only authorize-style endpoint this plugin config actually mounts — and 302-redirects to the same URL with `prompt` rewritten to exactly one canonical `prompt=consent`, unless the request already carries precisely that. This is enforced for every non-canonical shape (absent, `none`, case variant, multi-value, duplicate keys), not just "missing", closing a `prompt=none` bypass an adversarial review caught in an earlier version of the guard. Consent can therefore never be silently skipped, matching the spec's never-auto-approve rule. This is a deliberate non-conformance with RFC `prompt=none` semantics (a client explicitly asking to skip the interactive prompt): better-auth 1.6.13 doesn't implement `prompt=none` correctly anyway (it would silently mint instead of returning `interaction_required`), so forcing consent is the safer behavior given the alternative. The guard's decision logic (`decideConsentRedirect`) is a pure function, unit-tested independently of the Nitro handler (13 cases).

### Consent page + login bounce

- `app/pages/oauth/consent.vue` — session-gated (an unauthenticated visit bounces through `/login` first, carrying the OAuth query). Reads `consent_code`/`client_id`/`scope` off the query, renders the client id and requested scopes with Approve/Deny, POSTs `{ accept, consent_code }` to `POST /api/auth/oauth2/consent`, then redirects the browser to the returned `redirectURI`.
- `app/pages/login.vue` — on successful sign-in, if the query still carries `client_id`+`response_type` (better-auth bounced an unauthenticated authorize request here), resumes the flow server-side via `navigateTo('/api/auth/mcp/authorize?<original query>', { external: true })` instead of routing to `/documents`.

### Data model — migration 0029

Three better-auth-managed tables in `server/db/schema/auth.ts`, alongside the existing `user`/`session`/`account`/`verification`:

- `oauth_application` — DCR-registered clients (`client_id`/`client_secret`, `redirect_urls`, `type`, `disabled`).
- `oauth_access_token` — access + refresh tokens (`access_token_expires_at`, `refresh_token_expires_at`, `client_id` → `oauth_application.client_id`, `user_id`, `scopes`); cascade-deletes with the owning client/user.
- `oauth_consent` — consent decisions (`consent_given`, `scopes`, `client_id`, `user_id`).

`api_tokens` (the `mm_` token table) is a separate table, untouched by this work.

### Verify

```bash
curl -s https://brain.costanzoclan.com/.well-known/oauth-authorization-server | jq
curl -s https://brain.costanzoclan.com/.well-known/oauth-protected-resource | jq
curl -si -X POST https://brain.costanzoclan.com/api/mcp | rg -i 'www-authenticate'
```

`scripts/mcp-oauth-e2e.mjs` scripts the non-interactive half of the flow (DCR register → PKCE authorize URL → token exchange → `/api/mcp` call) for re-running without a real MCP client; pair it with a `playwright-cli` browser leg for the login/consent steps (see the script's header comment for exact usage).

## Server `instructions` preamble
Added in cycle 40: `new McpServer(info, { instructions: MCP_INSTRUCTIONS })` passes a server-level preamble (verified supported by the SDK's `ServerOptions.instructions`). The preamble establishes the second-brain workflow — search before answering, persist durable facts, file under projects, prefer surgical `edit_document` — so agents reliably reach for MyMind tools rather than answering from their own recollection.

## Tools (`server/lib/mcp/server.ts`)
The MCP surface is **auto-derived**: `server.ts` iterates `agentTools` (`server/lib/agent/tools.ts`) and registers every **non-`dangerous`** tool — no per-tool MCP wiring. `test/mcp-parity.test.ts` asserts the MCP set == the non-dangerous agent set. All 29 tools are currently non-dangerous, so the full registry is exposed (29 rows below).

### `kind` policy
Each tool carries a `kind` field that controls gating + description copy:
- `kind:read` — pure reads; always ungated.
- `kind:create` — write/mutate (including edits to existing docs); ungated by design (cycle 40 decision: edits must never be blocked by a confirmation gate, even if `kind:destructive` gets gated in the future).
- `kind:destructive` — removal/archive actions; descriptive today (signals "confirm with user" language + undo); NOT hard-gated.
- `dangerous:true` — the **only** hard runtime gate (checked in `ai-tools.ts`). A tool with `dangerous:true` is **never exposed to MCP** and is never callable without approval. Currently only `exec`. All 29 MCP tools are non-`dangerous`.

### Tool table

| Tool | kind | Delegates to |
|---|---|---|
| `search_memories(query, scope?, project?, limit?)` | read | memory.searchMemories |
| `save_memory(content, scope, project?, tags?, source?, confidence?)` | create | memory.createMemory |
| `get_recent_memories(scope?, limit?)` | read | memory.listMemories |
| `search_docs(query, project?)` | read | documents.searchDocs |
| `search_passages(query, project?, limit?)` | read | documents.searchPassages (chunk-level RAG, cycle 31) |
| `list_documents(project?)` | read | documents.listDocs |
| `get_document(id)` | read | documents.getDoc |
| `save_document(content, project?, title?, path?)` | create | documents.createDoc |
| `read_document(id, { heading?, offset?, limit? })` | read | edit-ops `outline` / `readSection` (cycle 40) |
| `grep_document(id, pattern, { regex?, context?, max? })` | read | edit-ops `grepContent` (cycle 40) |
| `edit_document(id, old_string, new_string, replace_all?)` | create | edit-ops `applyReplace` → documents.updateDoc (cycle 40) |
| `edit_section(id, { mode, text, heading? })` | create | edit-ops `applyEditSection` → documents.updateDoc (cycle 40) |
| `update_document(id, { title?, content?, frontmatter?, tags?, domain?, type?, project? })` | create | documents.updateDoc (cycle 40) |
| `move_document(id, path)` | create | documents.moveDoc (cycle 40) |
| `delete_document(id)` | destructive | documents.deleteDoc → restoreDoc undo (cycle 40) |
| `delete_task(id)` | destructive | tasks.deleteTask → restoreTask undo (cycle 40) |
| `forget_memory(id)` | destructive | memory.archiveMemory → unarchiveMemory undo (cycle 40) |
| `search_projects(activeOnly?)` | read | projects.listProjects |
| `get_project(slug)` | read | projects.getProject |
| `create_project(name, description?)` | create | projects.createProject |
| `edit_project(slug, name?, description?, active?)` | create | projects.updateProject |
| `create_task(title, ...)` | create | tasks.createTask |
| `search_tasks(status?, project?)` | read | tasks.listTasks |
| `edit_task(id, ...patch)` | create | tasks.updateTask |
| `quick_capture(text, title?)` | create | documents.createDoc |
| `web_search(query, count?)` | read | search provider (SearXNG/Brave); untrusted results (cycle 29) |
| `web_fetch(url)` | read | fetchAsMarkdown; SSRF-guarded, untrusted content (cycle 29) |
| `generate_image(prompt, ...)` | create | imagegen/comfy → images.createGeneratedImage (cycle 36) |
| `edit_image(instruction, source_image_id?, quality?)` | create | Qwen-Image-Edit-2509 instruction editing → images.createGeneratedImage (cycles 37–38; img2img+strength removed) |

`save_memory` params: `content` (string, max 20k), `scope` (user|agent|world), `project?` (slug), `tags?` (string[]), `source?` (string), `confidence?` (0–1 float). A `confidence >= 0.75` auto-reviews the memory; omitting it leaves it for manual review.

**Project-aware document tools** — for agents working inside a project: `search_docs`/`list_documents` accept a `project` slug to scope to one project; `get_document(id)` returns a doc's full content + frontmatter; `save_document(content, project?, …)` creates a doc and — when `project` is set — **auto-files it under `/projects/<slug>/`** via the cycle-26 path⟺project choke point (vs `quick_capture`, which drops a quick note in `/input`). `get_project(slug)` returns the full project model + session/memory/task/document counts.

**Long-doc agent workflow (cycle 40)** — agents should not round-trip the whole document body to make a small change. Instead: `read_document(id)` with no selector → outline + line/char counts; `read_document(id, { heading })` → just that section; `grep_document(id, pattern)` → locate the exact unique string; `edit_document(id, old, new)` → surgical patch. `edit_section` handles structure-aware append/replace. All mutations call `publishChange` (live-data rule) and return an `undo`.

**Pure `edit-ops.ts` module** (`server/lib/documents/edit-ops.ts`) — zero-DB string helpers underlying the cycle-40 edit tools: `outline`, `findSection`, `readSection`, `documentStats`, `grepContent`, `applyReplace`, `applyEditSection`. 26 unit tests; tool handlers do DB I/O around them.

Registered via `server.tool(name, description, zodShape, handler)`; each returns `{ content: [{ type:'text', text: JSON.stringify(result) }] }`.

## Validate
With a bearer token + `Accept: application/json, text/event-stream`, POST JSON-RPC `initialize`, `tools/list`, `tools/call`. Verified (cycle 40 live E2E, 2026-06-30): `tools/list` → 29 tools; full MCP round-trip (`save_document` → `read_document` → `grep_document` → `edit_document` → `edit_section` → `update_document` → `move_document` → `delete_document`) against the real `/api/mcp` StreamableHTTP endpoint, 28/28 assertions. (The `agent-tools` + `mcp-parity` unit tests assert the registry and that the MCP surface equals it exactly.)

## Notes / follow-ups
Stateless mode → no server-initiated notifications; tools only (no MCP resources/prompts) — sufficient for the agent tool-call use case.

**OAuth (cycle 48) deferred items:**
- **DCR cleanup cron** — `POST /api/auth/mcp/register` is open (no allowlist); rows are inert without an approved consent, but nothing yet prunes stale/abandoned `oauth_application` rows. Follow-up task, not merge-blocking.
- **Request-headers auth path** — Claude's beta that would let a header-capable client skip OAuth entirely is not rolled out to this account; OAuth is the only connector path until/unless that changes.
- Consent UX rough edges (non-blocking, noted in the handover): the Approve/Deny buttons don't cross-disable each other while one request is in flight, and an empty/missing `consent_code` isn't checked until a button is clicked (posts, then surfaces the resulting error) rather than failing upfront.
