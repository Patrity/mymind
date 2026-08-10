---
title: MCP Server
status: shipped
cycle: 53
updated: 2026-08-10
---

# MCP Server

Exposes MyMind to agents (Claude Code, etc.) over the Model Context Protocol, deprecating bridget's FastMCP server.

## Endpoint
`POST /api/mcp` — `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` in **stateless** mode (fresh `McpServer` + transport per request; no session store). Wired into the Nitro h3 handler (`server/api/mcp/index.post.ts`): reads the body, `server.connect(transport)`, `transport.handleRequest(event.node.req, event.node.res, body)`, then `event._handled = true` (h3 v1). Responses are SSE-framed JSON-RPC (clients send `Accept: application/json, text/event-stream`).

## Authentication

`/api/**` is gated by a single global middleware (`server/middleware/auth.ts`) that supports two independent client paths — pick based on what the client can do:

1. **`mm_` bearer API token** — machine clients that can set a static header (Claude Code, scripts, MCP Inspector with a manual token). Checked first against `api_tokens`. Mint/manage tokens and get a copy-paste MCP config at `/settings/api-keys` — see [`api-tokens.md`](api-tokens.md). Unaffected by everything below; `api_tokens` is a separate table from the OAuth tables.
2. **OAuth 2.1 (cycle 48)** — clients that only support a connector's browser-driven OAuth flow (claude.ai / Claude Desktop custom connectors). This is the only viable path for those surfaces: Claude's request-headers beta, which would let a header-capable client skip OAuth, is not available on this account.

On `/api/mcp` specifically, a bearer that fails the `mm_` lookup is retried as an OAuth access token (`useAuth().api.getMcpSession({ headers })`); elsewhere a failed `mm_` lookup 401s immediately (the session check only runs when no Bearer header is present at all). A 401 on `/api/mcp` carries the RFC 9728 discovery pointer — `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"` — so Claude can bootstrap OAuth discovery from a bare 401; every other route keeps the plain `WWW-Authenticate: Bearer` (unchanged).

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
| `oauth-authorization-server.get.ts` | RFC 8414 authorization-server metadata (`oAuthDiscoveryMetadata`) — issuer, the authorization, token, userinfo, jwks, and registration endpoints, `code_challenge_methods_supported: ["S256"]` |
| `oauth-protected-resource.get.ts` | RFC 9728 protected-resource metadata (`oAuthProtectedResourceMetadata`) — `resource`, `authorization_servers` |
| `oauth-protected-resource/api/mcp.get.ts` | Same RFC 9728 doc, served at the `/api/mcp`-suffixed path Claude also probes |

### Consent — forced on every authorize (`server/middleware/oauth-consent-guard.ts`)

better-auth 1.6.13's `mcp` plugin only shows the consent page when the authorize request carries the *exact* query value `prompt=consent` (`requireConsent: query.prompt === "consent"`, read directly from its `authorize.mjs`). There is no "already consented, skip" check in this code path, and no `OIDCOptions` knob to force consent server-wide — the only consent-adjacent option, a per-client `skipConsent` inside `trustedClients`, is an opt-out we don't configure. Left as better-auth ships it, an authorize request that simply omits `prompt` — or sends a near-miss like `prompt=none`, a case variant, a multi-value, or a duplicate key — silently mints a code with **no consent screen shown**, which would let a crafted link hijack a connector install onto an attacker's own account.

To close that, a Nitro global middleware (`oauth-consent-guard.ts`) intercepts `GET /api/auth/mcp/authorize` — the only authorize-style endpoint this plugin config actually mounts — and 302-redirects to the same URL with `prompt` rewritten to exactly one canonical `prompt=consent`, unless the request already carries precisely that. This is enforced for every non-canonical shape (absent, `none`, case variant, multi-value, duplicate keys), not just "missing", closing a `prompt=none` bypass an adversarial review caught in an earlier version of the guard. Consent can therefore never be silently skipped, matching the spec's never-auto-approve rule. This is a deliberate non-conformance with RFC `prompt=none` semantics (a client explicitly asking to skip the interactive prompt): better-auth 1.6.13 doesn't implement `prompt=none` correctly anyway (it would silently mint instead of returning `interaction_required`), so forcing consent is the safer behavior given the alternative. The guard's decision logic (`decideConsentRedirect`) is a pure function, unit-tested independently of the Nitro handler (13 cases).

### Consent page + login bounce

- `app/pages/oauth/consent.vue` — session-gated: an unauthenticated visit bounces through `/login` via the client-side global guard (`app/middleware/auth.global.ts`), which drops the OAuth query in the process (`navigateTo('/login')`, no query forwarded). This is harmless in practice — better-auth's own authorize step (`authorizeMCPOAuth`) only ever redirects the browser to `/oauth/consent` once a session already exists, so the page normally loads authenticated. On the rare edge case of no session at all, it's better-auth's own authorize-step bounce to `/login` (not this page's guard) that fires first and does carry the full query, so the flow still resumes correctly after sign-in (see `login.vue` below). Reads `consent_code`/`client_id`/`scope` off the query, renders the client identity and requested scopes with Approve/Deny, POSTs `{ accept, consent_code }` to `POST /api/auth/oauth2/consent`, then redirects the browser to the returned `redirectURI`.
- **Client identity on the consent screen.** better-auth's authorize redirect carries only `client_id` + `scope`, so the page looks the rest up via `GET /api/oauth/client/:clientId` (`server/api/oauth/client/[clientId].get.ts`) — a route we own because the `mcp` plugin re-exports only a subset of the OIDC provider's endpoints and `getOAuthClient` is **not** among them (its `/oauth2/client/:id` is never mounted; it 404s). Deliberately under `/api/oauth`, not the public `/api/auth` prefix, so the global guard requires a session. The lookup is client-side only (`useFetch(..., { server: false })`) since an SSR-time internal fetch wouldn't carry the session cookie.
- **Why the name is never shown alone.** Registration is open, so `client_name` is attacker-controlled — anyone can register as "MyMind Official". The screen therefore pairs the name with the **redirect host** (the domain the authorization code is actually delivered to, which an attacker can't forge without owning it) and the opaque client id, and the warning text says so explicitly. Display helpers live in `server/utils/oauth-client.ts` (`clientDisplayName` collapses whitespace so an embedded newline can't scroll the warning out of view, and truncates at 60 chars; `redirectHosts` parses better-auth's comma-separated `redirect_urls`, de-dupes, and drops unparseable entries) — 12 unit tests in `oauth-client.test.ts`. An unknown or un-looked-up client falls back to the raw client id: ugly, never misleading.
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
Added in cycle 40: `new McpServer(info, { instructions: MCP_INSTRUCTIONS })` passes a server-level preamble (verified supported by the SDK's `ServerOptions.instructions`; exported as `MCP_INSTRUCTIONS` from `server/lib/mcp/server.ts` so `test/agent-tools.test.ts` can assert on it). The preamble establishes the second-brain workflow — search before answering, persist durable facts, file under projects, `sync_document` when the agent holds the file (probe with `local_hash` first to skip the transfer when nothing changed) or surgical `edit_document`/`edit_section` otherwise — so agents reliably reach for MyMind tools rather than answering from their own recollection. On undo it says one thing, and it is the thing true for its reader: **"There is no undo tool here — get writes right the first time."** Cycle 53 shipped an earlier line ("most writes are undoable; an undo can decline, so check the result") and the final whole-branch review cut it: `MCP_INSTRUCTIONS` is consumed only by `buildMcpServer`, and an MCP client cannot invoke undo at all (next paragraph), so that line described a result its only audience can never obtain. Two tests hold the line honest (`test/agent-tools.test.ts`): the preamble must not contain `undoable`/`reversible`, must contain "no undo tool", and must stay ≤ 998 chars — it is prepended to every MCP session, so it earns its tokens or it goes. The undo *guards* below are real; they are real for the in-app agent surface, which is where they are documented.

**Undo does not exist on the MCP surface at all.** `buildMcpServer` (`server/lib/mcp/server.ts`) registers each tool's handler and returns only `{ content: [{ type: 'text', text: JSON.stringify(exec.result) }] }` — it never calls `registerUndo(exec.undo)`, so no undo token is ever handed to an MCP client. There is no `undo` tool anywhere in `agentTools`, and the only way to redeem a token, `runUndo` via `POST /api/agent/undo`, is a plain REST route an MCP session has no way to call. So every CAS/`updatedAt` guard described in this page is real for the **in-app agent surface only** (`server/lib/agent/ai-tools.ts` registers the token on every mutating call; `app/pages/agent/index.vue` and `app/pages/galaxy.vue` redeem it through `useUndo()`/`app/composables/useUndo.ts`, which POSTs that same route from inside the app). An MCP client — Claude Code, the MCP Inspector, claude.ai's connector — can call `edit_document` and get back a receipt, but it structurally cannot ever call undo on it. This is pre-existing (the gap predates cycle 53), not something that cycle introduced or closed. If an `undo` tool is ever exposed over MCP, the preamble line above is the first thing to revisit (there's a comment on `buildMcpServer` saying so).

**Where the guards live** (in-app surface): `edit_document`/`edit_section`/`update_document` and `sync_document`'s update branch CAS the content restore against the generated `content_hash` column (`casUpdateContent`); `move_document`, `update_document`'s metadata fields, and `sync_document`'s adopt/unchanged **and** update branches read-then-compare on `updatedAt`/`path` — an accepted TOCTOU, per the code's own comments, since no CAS primitive exists for those fields; `sync_document`'s create branch and the three retire tools (`delete_document`/`delete_task`/`forget_memory`) have no changed-since guard at all — their undo restores unconditionally once past the token check. `runUndo` (`server/lib/agent/undo.ts`) itself refuses outright on an expired/spent token, and wraps the closure invocation in a `try/catch` so a throwing undo answers `{ ok: false, reason }` instead of a raw 500 — a throw consumes the token (unlike a refusal, which stays retryable), because a thrown error is not something the caller can reconcile and retry into success. It is concretely reachable: `documents_path_live_uidx` is a unique index on live paths, so a `move_document`/`update_document` undo that writes the old path back throws a unique violation if something else has since taken that path. Both client call sites (`app/pages/agent/index.vue`, `app/pages/galaxy.vue`) also `try/catch` the redeem so a transport failure surfaces as a toast rather than an unhandled rejection.

## Tools (`server/lib/mcp/server.ts`)
The MCP surface is **auto-derived**: `server.ts` iterates `agentTools` (`server/lib/agent/tools.ts`) and registers every **non-`dangerous`** tool — no per-tool MCP wiring. `test/mcp-parity.test.ts` asserts the MCP set == the non-dangerous agent set. The table below is not exhaustive — the live registry is 38 tools (`test/agent-tools.test.ts` pins the full name list); it also includes the `use_skill`/`create_skill`/`edit_skill`/`delete_skill` progressive-disclosure tools documented in [`agent-skills.md`](agent-skills.md). All of them are currently non-dangerous.

### `kind` policy
Each tool carries a `kind` field that controls gating + description copy:
- `kind:read` — pure reads; always ungated.
- `kind:create` — write/mutate (including edits to existing docs); ungated by design (cycle 40 decision: edits must never be blocked by a confirmation gate, even if `kind:destructive` gets gated in the future).
- `kind:destructive` — removal/archive actions; descriptive today (signals "confirm with user" language + undo); NOT hard-gated.
- `dangerous:true` — the **only** hard runtime gate (checked in `ai-tools.ts`). A tool with `dangerous:true` is **never exposed to MCP** and is never callable without approval. Currently only `exec` (which lives outside `agentTools` — see [`agent-exec.md`](agent-exec.md) — so it was never a candidate for MCP exposure in the first place). All 38 `agentTools` are non-`dangerous`, so all 38 are MCP-exposed.

### Tool table

| Tool | kind | Delegates to |
|---|---|---|
| `search_memories(query, scope?, project?, limit?, includeUnreviewed?)` | read | memory.searchMemories |
| `save_memory(content, scope, project?, tags?, source?, confidence?)` | create | memory.createMemory |
| `get_recent_memories(scope?, limit?, includeUnreviewed?)` | read | memory.listMemories |
| `search_docs(query, project?, limit?, offset?)` → `{ items, total, hasMore }` (cycle 51) | read | documents.searchDocsPage |
| `search_passages(query, project?, limit?)` | read | documents.searchPassages (chunk-level RAG, cycle 31) |
| `list_documents(project?, limit?, offset?)` → `{ items, total, hasMore }` (cycle 51) | read | documents.listDocsSummary + countDocs |
| `get_document(id)` | read | documents.getDoc |
| `save_document(content, project?, title?, path?)` | create | documents.createDoc → receipt |
| `read_document(id, { heading?, offset?, limit? })` | read | edit-ops `outline` / `readSection` (cycle 40) |
| `grep_document(id, pattern, { regex?, context?, max? })` | read | edit-ops `grepContent` (cycle 40) |
| `edit_document(id, old_string, new_string, replace_all?)` | create | edit-ops `applyReplace` → documents.updateDoc → receipt (cycle 40) |
| `edit_section(id, { mode, text, heading? })` | create | edit-ops `applyEditSection` → documents.updateDoc (cycle 40) |
| `update_document(id, { title?, content?, frontmatter?, tags?, domain?, type?, project? })` | create | documents.updateDoc (cycle 40) |
| `move_document(id, path)` | create | documents.moveDoc (cycle 40) |
| `sync_document(id?, path?, content?, local_hash?, expected_hash?, force?, title?, tags?, type?, frontmatter?)` | create | edit-ops-free; `findDocByPath` + `casUpdateContent` → receipt + `action` |
| `delete_document(id)` | destructive | documents.deleteDoc → restoreDoc undo (cycle 40) |
| `delete_task(id)` | destructive | tasks.deleteTask → restoreTask undo (cycle 40) |
| `forget_memory(id)` | destructive | memory.archiveMemory → unarchiveMemory undo (cycle 40) |
| `search_projects(activeOnly?, limit?, offset?)` → `{ items, total, hasMore }` (cycle 51) | read | projects.listProjectsPage |
| `get_project(slug)` | read | projects.getProject |
| `create_project(name, description?)` | create | projects.createProject |
| `edit_project(slug, name?, description?, active?)` | create | projects.updateProject |
| `create_task(title, ...)` | create | tasks.createTask |
| `search_tasks(status?, project?, limit?, offset?)` → `{ items, total, hasMore }` (cycle 51) | read | tasks.listTasksSummary + countTasks |
| `edit_task(id, ...patch)` | create | tasks.updateTask |
| `quick_capture(text, title?)` | create | documents.createDoc |
| `web_search(query, count?)` | read | search provider (SearXNG/Brave); untrusted results (cycle 29) |
| `web_fetch(url)` | read | fetchAsMarkdown; SSRF-guarded, untrusted content (cycle 29) |
| `generate_image(prompt, ...)` | create | imagegen/comfy → images.createGeneratedImage (cycle 36) |
| `edit_image(instruction, source_image_id?, quality?)` | create | Qwen-Image-Edit-2509 instruction editing → images.createGeneratedImage (cycles 37–38; img2img+strength removed) |
| `search_messages(query, project?, session?, limit?)` | read | session-search `searchMessagesForAgent` (cycle 50) |
| `search_sessions(query, project?, limit?)` | read | session-search `searchSessionsForAgent` (cycle 50) |
| `read_around_message(messageId, radius?, full?, includeSidechain?)` | read | session-read `readAroundMessage` (cycle 50) |
| `read_session(sessionId, offset?, limit?, full?, includeSidechain?)` | read | session-read `readSessionPage` (cycle 50) |

`save_memory` params: `content` (string, max 20k), `scope` (user|agent|world), `project?` (slug), `tags?` (string[]), `source?` (string), `confidence?` (0–1 float). A `confidence >= 0.75` auto-reviews the memory; omitting it leaves it for manual review.

**Project-aware document tools** — for agents working inside a project: `search_docs`/`list_documents` accept a `project` slug to scope to one project; `get_document(id)` returns a doc's full content + frontmatter; `save_document(content, project?, …)` creates a doc and — when `project` is set — **auto-files it under `/projects/<slug>/`** via the cycle-26 path⟺project choke point (vs `quick_capture`, which drops a quick note in `/input`). `get_project(slug)` returns the full project model + session/memory/task/document counts.

**Long-doc agent workflow (cycle 40)** — agents should not round-trip the whole document body to make a small change. Instead: `read_document(id)` with no selector → outline + line/char counts; `read_document(id, { heading })` → just that section; `grep_document(id, pattern)` → locate the exact unique string; `edit_document(id, old, new)` → surgical patch. `edit_section` handles structure-aware append/replace. All mutations call `publishChange` (live-data rule) and return an `undo`.

**Pure `edit-ops.ts` module** (`server/lib/documents/edit-ops.ts`) — zero-DB string helpers underlying the cycle-40 edit tools: `outline`, `findSection`, `readSection`, `documentStats`, `grepContent`, `applyReplace`, `applyEditSection`. Unit-tested; tool handlers do DB I/O around them.

### Write receipts + typed edit failures

Document writes answer with a **body-free receipt**, never an echo of the document
(`server/lib/agent/receipt.ts`):

```jsonc
{ "ok": true, "id": "…", "path": "/projects/x/y.md", "title": "…", "project": "x",
  "type": null, "tags": [], "updatedAt": "…",
  "hash": "<sha256 of content>", "bytes": { "before": 102010, "after": 102019 },
  "replacements": 1 }            // find/replace edits only
```

Applies to `save_document`, `edit_document`, `edit_section`, `update_document`,
`move_document`, `quick_capture`. Reads are unchanged — `get_document` still returns the full
body on purpose.

This was a **correctness** fix, not only a cost one. Echoing the document back meant a write to
a large doc produced a response past the MCP host's tool-result cap, so a write that *had
already committed* reached the agent as an error — which it would then either retry
(double-applying, or failing on a now-stale `old_string`) or report as failed work. The same
`exec.result` feeds the in-app agent (`ai-tools.ts`), so the echo was burning its context too.

`hash` is the stored `documents.content_hash` — a Postgres **generated column** computed from
`content` (`doc_content_hash(content)`; see File sync below for the full detail), not a value
application code sets — letting a caller compare a local copy without re-reading the body.

### One failure shape across the document tools

Every document tool that can fail — `read_document`, `grep_document`, `edit_document`,
`edit_section`, `update_document`, `move_document`, `delete_document`, `sync_document` — answers
a failure with the **same shape**: `{ ok: false, error: <stable code> }` plus human-readable prose
and whatever extra fields that particular code carries. The prose field is `message` everywhere
**except** `sync_document`'s three divergence errors (`adopt_conflict`, `hash_mismatch`,
`expected_hash_required`), whose `divergenceReport` (`server/lib/agent/receipt.ts`) carries `hint`
— a next-action instruction — and no `message` at all. An agent branches on `error`, never on the
prose (it is for a human/log, not a spelling to pattern-match). The codes
`edit-ops.ts` produces (`server/lib/documents/edit-ops.ts`) are passed through verbatim by the
tool handler that calls it (`{ ok: false, ...res }`); the codes with no `edit-ops.ts` equivalent
(`not_found`, `no_fields`, and `sync_document`'s own `path_required`/`content_required`/
`adopt_conflict`/`hash_mismatch`/`expected_hash_required`) are owned by `tools.ts` directly. No
tool re-spells a code `edit-ops.ts` already owns.

| `error` | Which tool(s) | Extra fields |
|---|---|---|
| `not_found` | `read_document`, `grep_document`, `edit_document`, `edit_section`, `update_document`, `move_document`, `delete_document`, `sync_document` | `id` (or `path` for a `sync_document` path-addressed miss — see File sync below) — also covers the row being deleted between the read and the write landing |
| `no_match` | `edit_document` | `matches: 0` |
| `ambiguous_match` | `edit_document` | `matches: N`, `candidates: [{ line, text }]` (≤10 distinct lines, each clipped to 200 chars) |
| `empty_old_string` | `edit_document` | `matches: 0` |
| `heading_not_found` | `read_document`, `edit_section` | `outline`, `outlineTruncated` — see outline cap below |
| `ambiguous_heading` | `read_document`, `edit_section` | `outline`, `outlineTruncated` |
| `replace_needs_heading` | `edit_section` | `outline`, `outlineTruncated` |
| `invalid_regex` | `grep_document` | none beyond `message` (the native `RegExp` constructor's error text) |
| `no_fields` | `update_document` | none — no field in the patch at all |
| `path_required` | `sync_document` | upfront misuse guard: neither `id` nor `path` given |
| `content_required` | `sync_document` | upfront misuse guard: neither `content` nor `local_hash` given |
| `adopt_conflict` / `hash_mismatch` / `expected_hash_required` | `sync_document` | body-free divergence report: `id`, `server: { hash, bytes, updatedAt, headings }`, `local: { bytes }`, `hint` — **no `message`** — see File sync below |

Every one of these tools' `description` lists its own codes — the description is what the model
actually sees, so a code missing there is a code the agent cannot branch on. (`edit_document` and
`move_document` were missing `not_found`, and `sync_document` was missing `not_found`/
`path_required`/`content_required`, until the cycle-53 final fix wave.)

Nothing is written on any failure. Candidates are **distinct lines** (several hits on one line
collapse to one entry) and both the count and the per-line length are capped — an unclipped
candidate from a single 100 KB line would reintroduce the very overflow receipts prevent.

**Outline cap on a heading failure.** `heading_not_found`/`ambiguous_heading`/
`replace_needs_heading` return the document's heading outline alongside the error, so the agent
can immediately retry with a real heading instead of a second `read_document` round-trip — but an
unclipped outline on a document with hundreds of headings would reinflate the failure payload back
toward document size, the exact overflow receipts exist to prevent. `clipOutline`
(`server/lib/documents/edit-ops.ts`) caps it at `MAX_ERROR_OUTLINE` (50) and sets
`outlineTruncated: true` when the real outline is longer.

**`get_document` is the one remaining unconverted outlier.** It still returns the raw document (or
`null`) on a miss — no `ok`, no `error`, no `message`. Reads are otherwise unchanged: `get_document`
returns the full body on purpose (it's the by-id whole-document reader), and `list_documents`/
`search_docs`/`search_tasks`/`search_projects` return summaries as documented under
[Recall defaults](#recall-defaults-cycle-51) below — neither of those is a failure-shape question.

### File sync (`sync_document`)

Makes a MyMind document match a local file in one call, so an agent stops simulating a sync with
N hand-replayed `edit_document` calls.

The local file carries its own MyMind identity, so this works identically for a git repo, a
directory that isn't version-controlled, and MyMind-native docs (which simply have no file):

```markdown
---
mymind_id: 6d14a9c3-c421-4e49-a162-86536b8f534c
mymind_hash: 189d0cfb…
---
```

**The hash covers the body only — frontmatter is excluded.** A hash over the whole file changes
the moment you write it back into that file, so it never converges. MyMind stores `content` and
`frontmatter` as separate columns and `content_hash` is `sha256(content)`, so both sides hash the
same bytes with no normalisation layer.

| `action` | Condition | Content write |
|---|---|---|
| `created` | no `id`, `path` matches no live doc | yes |
| `adopted` | no `id`, `path` matches a live doc that already agrees | no — returns its `id` + `hash` |
| `updated` | `expected_hash` matches stored, or `force: true` | yes |
| `unchanged` | incoming content already equals stored | no |

`adopted`/`unchanged` never write **content**, but the `action` only describes the content
decision — if the same call also carries a new `path` (relocation) or `title`/`tags`/`type`/
`frontmatter`, that patch is still applied on top (see Relocation/Metadata below) and fires
exactly one `publishChange({ action: 'updated' })`. Only a call with no content change *and* no
such extra fields is a true no-op: no write, no event at all.

Writes **fail closed** — `hash_mismatch` (stale `expected_hash`), `adopt_conflict` (a path match
that diverges), `expected_hash_required` (an `id` write with nothing to compare). Each returns a
body-free divergence report (`server.hash`/`bytes`/`updatedAt`/`headings`, `local.bytes`) so the
agent can decide without pulling the document. Gated adoption is what stops a first sync from
clobbering a doc that was edited in the MyMind UI. Two more errors are upfront misuse guards
rather than sync-decision outcomes — `path_required` (neither `id` nor `path` given) and
`content_required` (neither `content` nor `local_hash` given) — both returned before any DB read.

The guard is in the `UPDATE`'s `WHERE content_hash = $expected`, not a preceding `SELECT` — a
read-then-write would let a concurrent edit slip between the two statements. A live E2E
(`scripts/sync-document-e2e.mjs`) fires two `sync_document` calls with the same `expected_hash`
concurrently against a real Postgres and asserts exactly one lands and the other comes back
`hash_mismatch` — the one guarantee a mocked-DB unit test cannot prove.

**Probe mode**: pass `local_hash` instead of `content` to ask whether the two sides agree with no
body transferred and no write → `{ ok, in_sync, server_hash, id }`. Works by `id` or by `path`.
The real cost of syncing a 121 KB doc is the upload, and most days nothing changed.

Passing `path` alongside `id` **relocates** the document (and re-files its project through the
path⟺project choke point), which is how a renamed local file converges instead of forking — this
applies even when the body is unchanged (an `unchanged`-action sync still relocates). Once moved,
the old path no longer resolves, but a probe and a sync react to that differently. A **probe**
(`local_hash`, no `id`) against the vacated path returns `not_found`, as expected. A path-only
**sync** (`content`, no `id`) against the vacated path does NOT return `not_found` — `decideSync`'s
`!target && !input.id → { kind: 'create' }` falls through and it silently creates a SECOND
document at the old path, forking the doc (this is the frozen spec's intended create-on-no-match
behaviour, asserted by `server/lib/agent/sync.test.ts`, not a bug). This is exactly why a file
should carry `mymind_id` in its frontmatter after its first sync: passing `id` is what makes a
later rename relocate the existing document instead of forking a new one at whatever path the
file used to live at.

**Metadata passthrough**: `tags`, `type`, `title`, and `frontmatter` sent with a sync are always
persisted in the same call — no separate round-trip needed to keep them in sync with the file.
On `created` they're forwarded straight into the insert (`createDoc`); on every other outcome
that isn't refused (`adopted`/`unchanged`/`updated`) they're patched on afterward via the same
`applySyncMeta` helper `update_document` uses. A refused write (any `ok:false`) never touches
metadata.

**Deletes are out of scope.** A deleted local file does not remove its document — a sync that
deletes on absence is one bad glob away from wiping the wiki. Retirement stays deliberate via
`delete_document`.

`documents.content_hash` is a **Postgres generated column** (`doc_content_hash(content)`, an
explicitly-immutable wrapper — a bare `convert_to()` expression is rejected as not immutable).
Application code cannot leave it stale, which matters because `image-enrich.ts` writes `content`
via a raw `db.update()` that bypasses `updateDoc`.

### Session search + transcript read (cycle 50)

MyMind ingests every Claude Code session (transcript messages + tool events, project-associated) and already ran hybrid search over sessions/messages for the web UI (`server/services/session-search.ts`) — cycle 50 wraps that as four `kind:read` MCP tools, plus a new bounded-read service (`server/services/session-read.ts`) so an agent can actually consume a hit instead of just locating it. Zero migration, zero new UI — the web still has global session search + `/sessions/[id]`.

- **`search_messages(query, project?, session?, limit?)`** — the primary "find a keyword or topic in past sessions" tool. Same hybrid (trigram + vector, RRF-fused) ranking as the web search, filtered to `project` slug and/or one `session` id. **Always excludes sidechain (subagent/Task) messages** — there is no `includeSidechain` param here, unlike the read tools. Each hit's `snippet` is **match-centered**: `snippetAround()` (`session-read.ts`) finds the first case-insensitive occurrence of `query` in the message and returns a ~240-char window (±120 chars) around it with `…` elision, falling back to a head-slice when the hit came from the vector lane with no literal substring match. Returns `{ results: [{ messageId, sessionId, role, snippet, createdAt, sessionTitle, project }] }` — feed a `messageId` into `read_around_message` to see the surrounding conversation.
- **`search_sessions(query, project?, limit?)`** — session-level topic search (hybrid over `title` + `summary`) for "which session was this in" when there's no exact keyword to grep for. Returns `{ results: [{ sessionId, title, snippet, project, startedAt, messageCount }] }` — feed a `sessionId` into `read_session` to page the transcript.
- **`read_around_message(messageId, radius?, full?, includeSidechain?)`** — the focal message plus `radius` messages before/after (default 8, max 30) in the same session, chronological. 404-shaped (`{ error: 'message not found', messageId }`) rather than throwing when the id doesn't exist.
- **`read_session(sessionId, offset?, limit?, full?, includeSidechain?)`** — pages the whole transcript in chronological order (`offset`/`limit`, default 0/25, max 50). Returns session meta (`{ id, title, project, startedAt, endedAt, messageCount }`) plus `{ offset, limit, returned, hasMore, items }`; `hasMore` is a `returned === limit` heuristic, not a stored count, so a consumer keeps paging on `hasMore` rather than trusting `messageCount` (which is a raw ingest total that may include sidechain).

**Message ↔ tool-event interleave.** Messages and tool calls/outputs live in separate tables (`messages`, `tool_events`, joined by `messageId`) — a transcript is not just a list of messages. Both read tools merge them into one `items: (MessageItem | ToolEventItem)[]` array ordered by `createdAt` (`interleave()` in `session-read.ts`), so a tool call/result sits right after the assistant turn that issued it, exactly as it read live.

**Truncation and `full`.** By default (`full: false`, the default on every tool above) a `MessageItem.content` is capped at `CONTENT_CAP` (2000 chars) and `thinking` is dropped entirely; a `ToolEventItem`'s `argsSnippet`/`resultSnippet` (the JSON-stringified `args`/`result`) are each capped at `TOOL_CAP` (600 chars). Any cap that actually trims sets `truncated` to the number of chars omitted, so the agent knows there's more and can re-call with `full: true` to get the untruncated content (and `thinking`) — a deliberate token-budget default, not a hidden data loss.

**Sidechain excluded by default.** Subagent/Task-tool threads are tagged `isSidechain` on both `messages` and `tool_events`. `read_around_message`/`read_session` default `includeSidechain` to `false` (opt in to see subagent chatter); `search_messages` has no such option — it always excludes sidechain, since a keyword hit inside a subagent's internal scratch space is rarely what the caller wants. `search_sessions` has no sidechain concept (session rows don't distinguish sidechain vs. main-thread content).

No migration and no UI changes — this cycle is pure MCP/agent tool surface over the existing `sessions`/`messages`/`tool_events` tables and the existing hybrid search services (`project`/`session` became new optional filters on `searchSessions`/`searchMessages`, backward-compatible with the unchanged web callers).

Registered via `server.tool(name, description, zodShape, handler)`; each returns `{ content: [{ type:'text', text: JSON.stringify(result) }] }`.

### Recall defaults (cycle 51)

`list_documents`, `search_docs`, `search_tasks`, and `search_projects` return **summaries**, never full bodies: `list_documents`/`search_docs` items omit `content`; `search_tasks` items omit `description`; `search_projects` items omit `aliases`/`localPaths`/`pathPrefixes`. Document bodies come from the by-id readers — `get_document`, `read_document` (outline/section/window), `grep_document` — never from a list/search result. Each tool's `description` states this explicitly so an agent doesn't conclude a document is empty.

All four take `limit`/`offset` and return an envelope: `{ items, total, hasMore }`. Default page size is **25**, max **100** (`server/lib/agent/paging.ts`, `clampPaging`/`buildPage`).

- For `search_docs`, `total` counts **candidate matches considered** (the fused trigram+vector RRF candidate pool, capped ~50 per lane) — it is not the size of the document corpus, and it is not guaranteed to equal the true number of matching documents.
- For `list_documents`/`search_tasks`/`search_projects`, `total` is an exact `count(*)` over the same filter as the returned rows (built from the identical conditions array), so it can never disagree with a full page-through.
- `search_projects` is a **misnomer**: it takes no query/keyword parameter and does no text matching. It only lists projects, optionally filtered by `activeOnly`. There has never been a `searchProjects(q)` in this codebase — the name predates any query capability, and cycle 51 confirmed and documented that rather than inventing one (see the cycle-51 handover).

`search_memories`/`get_recent_memories` exclude unreviewed memories by default (`reviewedAt IS NOT NULL`) — pass `includeUnreviewed: true` to include them (e.g. to confirm a memory you just saved before it has been reviewed). The web `/memories` review surface is unaffected and still shows unreviewed rows; this filter only changes agent-facing recall.

**Breaking MCP contract change:** before cycle 51, `list_documents`/`search_docs` results carried each document's full body inline (`result[].content`). Any consumer still reading that field off those two tools now gets `undefined`. Read the body via `get_document`/`read_document`/`grep_document` instead — the tool descriptions say so explicitly.

## Validate
With a bearer token + `Accept: application/json, text/event-stream`, POST JSON-RPC `initialize`, `tools/list`, `tools/call`. Verified (cycle 40 live E2E, 2026-06-30): `tools/list` → 29 tools; full MCP round-trip (`save_document` → `read_document` → `grep_document` → `edit_document` → `edit_section` → `update_document` → `move_document` → `delete_document`) against the real `/api/mcp` StreamableHTTP endpoint, 28/28 assertions. (The `agent-tools` + `mcp-parity` unit tests assert the registry and that the MCP surface equals it exactly.)

`scripts/sync-document-e2e.mjs` is the equivalent live E2E for `sync_document` (2026-08-02): create → create-path metadata (`tags`/`type` on a second, dedicated document — the create branch used to silently drop them — verified in the receipt AND via a `get_document` read-back) → idempotent adopt → adopt_conflict → CAS update → stale-hash rejection → unchanged → probe (by id and by path) → force-override → relocation → old-path probe after relocation (`not_found`) → update-path metadata (`tags`/`type`) passthrough verified via `get_document` read-back → a genuine concurrency race (two `sync_document` calls sharing one `expected_hash` fired with `Promise.all`), against the real `/api/mcp` endpoint and a real Postgres — 28/28 assertions, exactly one racer wins the CAS and the loser comes back `hash_mismatch`. Run it with `node scripts/sync-document-e2e.mjs <mm_ token> [baseUrl]` against a disposable API token; it self-cleans the two documents it creates.

## Notes / follow-ups
Stateless mode → no server-initiated notifications; tools only (no MCP resources/prompts) — sufficient for the agent tool-call use case.

**OAuth (cycle 48) deferred items:**
- **DCR cleanup cron** — `POST /api/auth/mcp/register` is open (no allowlist); rows are inert without an approved consent, but nothing yet prunes stale/abandoned `oauth_application` rows. Follow-up task, not merge-blocking.
- **Request-headers auth path** — Claude's beta that would let a header-capable client skip OAuth entirely is not rolled out to this account; OAuth is the only connector path until/unless that changes.
- Consent UX rough edges (non-blocking, noted in the handover): the Approve/Deny buttons don't cross-disable each other while one request is in flight, and an empty/missing `consent_code` isn't checked until a button is clicked (posts, then surfaces the resulting error) rather than failing upfront.
