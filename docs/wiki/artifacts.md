---
title: Artifacts (sandboxed pages and webapps Bridget publishes)
status: built
cycle: 86
updated: 2026-10-15
mymind_id: f60aa8d8-a6f1-4558-9838-1f549a55b82e
mymind_hash: 95101631628284050c71cfb431effd2cc5ef6c87fe01865bc6916111e60e2441
---

# Artifacts (cycle 86)

Bridget can write and build code in her sandbox ([`workspace.md`](workspace.md)) and now has somewhere to
*show* it: an **artifact** is a versioned static bundle (one HTML page, or a built webapp) served at
`/artifact/<slug>/`, public or private, inside a browser sandbox that gives it no access to MyMind. No
server-side code runs; a page that needs fresh data reads relative `data/*.json` files that Bridget (or a job)
refreshes in place.

Code: `packages/core/src/lib/artifacts/{limits,manifest,serve,token,service,workspace-bundle,html-warnings}.ts`,
`packages/core/src/db/schema/artifacts.ts`, `packages/core/src/shared/types/artifacts.ts`,
`packages/core/src/lib/agent/tools/artifacts.ts`, `server/routes/artifact/[...rest].ts`,
`server/api/artifacts/**`, `app/pages/artifacts/{index,[id]}.vue`, `app/components/artifacts/{Frame,ChatCard}.vue`,
`app/composables/useArtifacts.ts`, `app/lib/artifacts/display.ts`. Spec:
[`2026-10-15-artifacts-design.md`](../superpowers/specs/2026-10-15-artifacts-design.md). Handover:
[`2026-10-15-artifacts.md`](../handovers/2026-10-15-artifacts.md). Builds on [`workspace.md`](workspace.md),
[`judge.md`](judge.md) (taint/approval gate), [`live-reactivity.md`](live-reactivity.md).

## 1. Data model (migration `0089_sleepy_goblin_queen`)

`artifacts`

| column | notes |
|---|---|
| `id` uuid pk | |
| `slug` text | unique among live rows (`artifacts_slug_live_uidx` where `deleted_at is null`); `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` |
| `title`, `description` | title required on create |
| `is_public` bool, default false | |
| `project_id` -> projects (set null), `conversation_id` -> conversations (set null) | `conversation_id` = the run's chat; stamped by the server, never the model |
| `current_version_id` -> artifact_versions (set null) | what is served |
| `created_at`, `updated_at`, `deleted_at` | soft delete; index `artifacts_project_idx` |

`artifact_versions`

| column | notes |
|---|---|
| `artifact_id` -> artifacts (cascade), `version` int | unique `(artifact_id, version)`, 1-based |
| `manifest` jsonb | `{ "<path>": { key, sha256, size, contentType } }`; `key` is the blob in storage |
| `entry` text (default `index.html`), `spa_fallback` bool | |
| `total_bytes` int | |

Blobs go through `storage()` (the same store as `/api/i/[slug]`), written **before** the DB transaction; the
artifact row and version row land in one transaction. Live updates: `publishChange({ resource: 'artifact' })` on
every service write (create/update; restore also emits `created`), including worker publishes.

## 2. Limits and allowed types

- 500 files, 25 MB total, 10 MB per file (`ARTIFACT_MAX_FILES`, `ARTIFACT_MAX_TOTAL_BYTES`, `ARTIFACT_MAX_FILE_BYTES`).
- Paths: relative, `/`-separated, no `..`, no empty segments, no backslashes or NUL, no leading/trailing `/`.
- Content-type **allowlist by extension**: html htm js mjs css json map txt csv svg png jpg jpeg gif webp avif ico
  woff woff2 ttf wasm mp3 mp4 webm. Anything else is `bad_type` when passed directly.
- `ArtifactError` codes: `bad_path bad_type too_large too_many no_entry bad_slug not_found bad_input refused`.
- **Skipped types (workspace publish only).** `workspace_path` publishing *skips* files of unlisted types rather
  than failing (Vite `dist/` routinely holds `.webmanifest`, `LICENSE`, `.gz`). Skipped files do not count toward
  the limits and the tool result carries a warning naming them (first 10). A needed asset of an unlisted type 404s.

## 3. Serving route

`server/routes/artifact/[...rest].ts` (outside `/api`, so it does its own auth). Every decision is the pure
`decideArtifactRequest` in `serve.ts`; the route only does IO. `GET`/`HEAD`; `OPTIONS` answers 204; other methods 404.

Headers on **every** response (200, 304, 404, 403, 500, redirects):

| header | value |
|---|---|
| `Content-Security-Policy` | `sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads` (no `allow-same-origin`) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Access-Control-Allow-Origin` | `*` (never credentials; OPTIONS adds methods `GET, HEAD`, headers `*`, max-age 600) |
| `Cache-Control` | public: `public, max-age=60`; private: `private, no-store` |

File responses add `Content-Type` (manifest), `Content-Length`, and `ETag: "<sha256>"` (`If-None-Match` -> 304).

**Why CORS `*`:** the CSP `sandbox` gives the document an *opaque origin*, so even its same-site `fetch('./data/x.json')`
is cross-origin and fails without ACAO. `*` without credentials exposes nothing beyond what the URL (including a
private token) already grants.

Decision table (`u` = parsed URL; navigation = `Sec-Fetch-Dest` document/iframe or absent):

| request | result |
|---|---|
| unknown/deleted slug, or invalid slug | 404 |
| no trailing slash | public: 301 to `/artifact/<slug>/`; private + non-navigation: 404 (looks missing); private navigation: 301 |
| public | serve |
| private + valid token for *this* artifact | serve |
| private, no usable token, non-navigation | token present: **403**; none: 404 |
| private navigation + session | 302 to `/artifact/<slug>/~<token>/<path>` (query kept) |
| private navigation, no session | 302 to `/login?redirect=/artifact/<slug>/` |

Path lookup (`lookupPath`): `''` -> entry; trailing `/` -> `<dir>/index.html`; exact manifest hit; else, only if
`spa_fallback` **and** the request is a navigation to an extension-less path, the entry. A `fetch()` of an SPA route
therefore 404s by design. Lookups use own-key reads (`constructor`, `__proto__` are not hits). Login redirects back
through `app/pages/login.vue`, which does a full `window.location.assign` for `/artifact/**` targets (it is a Nitro
route; the SPA router would 404 it).

## 4. Private access: the path token

A private page renders in a sandboxed iframe or top-level document, but its **subresource** requests (JS, CSS,
`fetch`) come from an opaque origin and **do not carry the session cookie** (verified in the browser: the document
navigation carries it, `app.js` and `data/x.json` do not, both top-level and in the iframe). So the session is
exchanged once for a path token and every relative URL inherits it:

- `signViewToken(artifactId)` = base64url(`<artifactId>.<expiryMs>`) + `.` + HMAC-SHA256, key derived from
  `BETTER_AUTH_SECRET` (`artifact-view:v1`); TTL **12 h**. No secret -> throws -> route answers a bare 500, never serves.
- `verifyViewToken` -> `ok | expired | invalid`; constant-time compare, bound to the artifact id (a token for A never
  serves B), tampering/expiry rejected. An expired token on a navigation falls back to the session check.
- The first path segment starting `~` is the token (a root file literally named `~x` is unreachable).
- `GET /api/artifacts/:id/view-url` returns the relative URL: public -> `/artifact/<slug>/`, private ->
  `/artifact/<slug>/~<token>/`. **Session-only** (`requireSession`): an API/bearer token cannot mint view tokens.
- Relative asset URLs resolve under `~<token>/`, so the page needs no cooperation. Vite must use `base: './'`.

Security consequence: anyone holding a private token URL can read that artifact for up to 12 h (like a signed link).

## 5. Isolation proof

Fixture `test/fixtures/artifacts/isolation/` tries `document.cookie`, `localStorage`, `fetch('/api/…', { credentials:
'include' })` and reads `location.origin`, writing results into the DOM. Verified with playwright, logged in, as a top
level navigation and inside the `/artifacts/<id>` iframe:

- CSP on: cookie threw, localStorage threw, origin `null`, API call blocked. Relative `data/x.json` loaded (`{"value":7}`).
- Mutation `ARTIFACT_CSP = ''`: cookie readable (session-adjacent cookies visible), localStorage ok, origin
  `http://localhost:3086`, API call 200. Restored via `git checkout`; the proof bites. Never committed.

Logged out: a public artifact renders (all four blocked); a private one redirects to `/login?redirect=…` and, after
login, lands on `/artifact/<slug>/~<token>/` rendered.

## 6. Agent tools (toolset `artifacts`, on-demand via `load_toolsets`)

| tool | kind / class | notes |
|---|---|---|
| `publish_artifact` | `create`; `outboundWhen: public === true`, `proposeWhen` same | exactly one of `html` / `files` (map path -> text) / `workspace_path`; `files: {}` counts as absent; zero sources -> `{ok:false}` "nothing to publish"; `entry`, `spa_fallback`, `public`, `project` (slug), `merge`, `slug`, `title`, `description` |
| `edit_artifact` | `create`; `outboundWhen`/`proposeWhen` when `public: true` | title, description, slug, `public`, `project` (null clears), `rollback_to` (version number) |
| `list_artifacts` | `read` | newest first, optional `project`, `limit` (1-100) |
| `delete_artifact` | `destructive`, `dangerous`, `describeApproval` | soft delete; undo restores (fails if the slug was reused) |

Gate behaviour:

- A **private** publish/edit is Bridget's own output: `publish_artifact`/`edit_artifact` sit in `APPEND_TOOLS`
  (`runtime/gate.ts`) so they run without approval, with undo, and a rollback-capable chat card.
- A call with `public: true` is **outbound**: the judge rule tier treats it like `gmail_send`-class outbound
  (`outboundWhen` in `judge/rules.ts`), needs Tony's approval in a live run, and in a headless run is **proposed**
  (`proposeWhen`) rather than executed.
- **Tainted run + already-public target + no explicit `public` flag -> `{ok:false}` refusal** ("pass public: true ...
  Tony must approve"): an args-only gate cannot see that the stored artifact is already public, so the call is forced
  through the gate. `public: false` (making it private) is allowed.
- `delete_artifact` is `dangerous`, so it lives on `bridgetProfile` (`artifactDangerousTools`), **never** in the shared
  `agentTools`/MCP registry (`test/mcp-dangerous.test.ts`).
- **MCP:** `publish_artifact`, `edit_artifact`, `list_artifacts` are exposed (the toolset is not MCP-excluded). Public
  publish over MCP is **ungated**: MCP callers are Tony's own authenticated clients with no taint model, equivalent to
  Tony flipping the switch in the UI. `workspace_path` is refused over MCP (no workspace); `delete_artifact` is not offered.
- **Proposal replay.** An approved headless proposal re-runs the handler with `ctx.replay = true` (set only by
  `runtime/replay.ts`); `proposalArgs` pinned the originating `workspaceId` and `conversationId`, honoured only under
  `replay`. Live runs ignore model-supplied ids and resolve from the run; MCP ignores them too.
- Undo (`ToolExecution.undo`): a create -> soft delete; a new version -> set `current_version_id` back to the
  previous version, restoring metadata *first* (a once-private version must never be briefly current on a still-public
  artifact); an edit -> restores title/description/slug/visibility/project (and the prior current version after a rollback).
- Tool result: `{ ok, id, slug, title, url, isPublic, version, newVersion, created, warnings[] }` (same shape for
  edit, so the chat card renders for both). Warnings: root-absolute asset refs in the entry HTML (`/assets/x.js` will
  404 under `/artifact/<slug>/`: rebuild with `base: './'`), masked secret count, skipped file types. The tool
  description tells the model to put the artifact URL in its reply and to omit `project` unless known.

## 7. Publishing from the workspace (`workspace-bundle.ts`)

`workspace_path` is a directory inside the run's workspace (e.g. `dist`). Two fixed Python scripts run **inside the
container** (paths as JSON on stdin, realpath-contained under `/workspace`): a walk (dot-dirs, `node_modules`,
symlinks and non-regular files pruned; at most 5000 entries) and chunked base64 reads (`CHUNK_BYTES` batches). The
host enforces the limits against what the container reports, so a forged size cannot loop it.

- Text types (`html htm js mjs css json map txt csv svg`) are **secret-masked** with the workspace secret store
  (`maskText`). Masking is **literal-only**: escaped, base64-encoded or wasm-embedded secrets are not caught.
- Unreadable secret store -> `ArtifactError('refused')`, nothing published.
- A tainted run reads through the taint-aware network mode (`runNetworkMode`).

## 8. Updating data without a new version

`publishArtifact` decisions, in order, against the current version (`entry` and `spa_fallback` unchanged):

1. Only files under `data/` differ (`onlyDataChanged`) -> **update in place**: the current version's manifest is
   rewritten, version number unchanged, no new row. Result `newVersion:false`, tool summary "updated data of X (vN, in place)".
2. Manifest identical (same sha256 set) -> no change; only metadata (title/visibility/...) is updated.
3. Anything else -> new version `max+1`, becomes current.

`merge: true` overlays the given files on the current manifest; without it the published files **replace** the whole
bundle. Pages should fetch data **relatively** (`fetch('./data/x.json')`). A refreshing dashboard is a normal job
(`create_job`) whose prompt calls `publish_artifact({ slug, files: { 'data/x.json': ... }, merge: true })`. In-place
edits are not individually reversible by `rollback_to` (there is no prior copy); concurrent first-publishes of one new
slug race on the unique index and the loser retries (bounded, 3) as an update.

## 9. API (`server/api/artifacts/`, session or bearer)

| route | notes |
|---|---|
| `GET /api/artifacts` | list (`?project=` uuid) |
| `GET /api/artifacts/:id` | detail with `versions[]` (`id, version, entry, fileCount, totalBytes, createdAt, current`); `:id` is a uuid or a slug |
| `PATCH /api/artifacts/:id` | `{ title, description, slug, isPublic, projectId, rollbackTo }` (zod; 400 on bad body/`ArtifactError`) |
| `DELETE /api/artifacts/:id` | soft delete |
| `GET /api/artifacts/:id/view-url` | session only; see § 4 |

The service emits the live-bus change; routes do not.

## 10. UI

- Sidebar entry **Artifacts** (`/artifacts`).
- `/artifacts`: list with title, slug, project, visibility `USwitch`, versions, updated, open/copy/delete; live via vue-query.
- `/artifacts/[id]`: sandboxed iframe preview (`sandbox="allow-scripts allow-forms allow-popups allow-modals
  allow-downloads"`, constant `ARTIFACT_SANDBOX` pinned by a test, never `allow-same-origin`), metadata form, version
  history with rollback, project and source-conversation links. The iframe is keyed on `url@currentVersion` so it
  remounts after a new version/rollback. The form re-syncs from live refetches only for a different artifact or while
  it is still clean (never overwrites unsaved edits).
- Chat card: `publish_artifact`/`edit_artifact` results render an inline iframe preview with Open / Copy link
  (`ChatCard.vue` via `ToolPart.vue`). Each card mints a view-url; the card's iframe does not remount on later versions.

## 11. Known limits

- **Pages cannot use `localStorage`/`sessionStorage`/`document.cookie`** (they throw) or authenticated MyMind APIs.
  Use in-memory state or `data/*.json`.
- **Vite needs `base: './'`**; root-absolute URLs 404 under `/artifact/<slug>/` (the tool warns when it can see them;
  `rootAbsoluteRefs` misses unquoted attributes).
- Secret masking is literal-only and text-types-only (see § 7).
- **No blob GC**: deleting an artifact, a failed publish, or replacing a bundle leaves orphaned blobs in storage.
- No backends/server code, custom domains, thumbnails, comments. View tokens last 12 h and cannot be revoked
  individually (rotate `BETTER_AUTH_SECRET` to kill them all, which also logs everyone out).
- Public pages are cached 60 s, so a data refresh shows within a minute.
