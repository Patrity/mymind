---
title: "Artifacts — Bridget publishes sandboxed HTML pages and built webapps at /artifact/<slug> (cycle 87)"
cycle: 87
date: 2026-10-15
status: built  # shipped on feat/artifacts 2026-10-15; see docs/handovers/2026-10-15-artifacts.md
supersedes: null
builds_on: 2026-10-11-sandboxed-workspace-design.md
---

# Artifacts (cycle 87)

Bridget can write and build code in her sandbox (cycle 82) but has nowhere to *show* it. This cycle
gives her Claude-style artifacts: small demos, data visualisations and visual previews, published as a
static bundle at `https://brain.costanzoclan.com/artifact/<slug>`, recorded in the DB, versioned, and
marked public or private.

## 1. Intent (brainstorm 2026-10-15)

- **Purpose:** like Claude's artifacts — Bridget conveys data visually, previews something, or builds a
  small demo / side project (not necessarily MyMind-related).
- **Data:** mostly baked-in snapshots; "live" dashboards get there by Bridget refreshing a data file on
  a schedule. No live query API this cycle.
- **Persistence:** artifacts are static. They don't get `localStorage`/cookies; no backends.
- **Success:** Bridget can publish a single HTML page *or* a Vite-built `dist/` from her workspace in
  one tool call, Tony gets a working URL, can flip it public/private, see it inline in chat, list and
  roll back versions — and nothing an artifact runs can touch Tony's session or `/api`.

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| D1 | Serve on the main origin at `/artifact/<slug>/…`, isolated with `Content-Security-Policy: sandbox …` (no `allow-same-origin`) → opaque origin, no cookie/session/`/api` access | separate subdomain (would give `localStorage`, but costs DNS/Pangolin + a cross-origin login handoff); serving unsandboxed |
| D2 | Static bundles only: `html` (single file), `files` (inline map) or `workspace_path` (a directory in Bridget's sandbox, e.g. `dist/`) | per-app containers/backends (a later cycle if ever) |
| D3 | Live data = files under `data/` rewritten by an ordinary MyMind job calling `publish_artifact` | curated live read API with scoped tokens (possible later, private-only) |
| D4 | Every non-`data/` publish = new immutable version; `data/` changes patch the current version in place | version per refresh (96/day); no versioning |
| D5 | Private by default. Private assets load through a signed path token minted after a session check (§5) | changing the auth cookie's SameSite; query-string tokens |
| D6 | `publish_artifact` runs without approval; making an artifact **public** is `outbound` (approval in a tainted run, per the existing gate); `delete_artifact` is destructive | dangerous-gate every publish |
| D7 | Storage reuses the content-addressed driver; a version's manifest maps `path → sha256` | new storage layout / directory-per-artifact |
| D8 | CDN scripts/styles allowed (no `default-src` lockdown) — the sandbox, not a CSP allowlist, is the security boundary | CDN allowlist |

## 3. Data model (`packages/core/src/db/schema/artifacts.ts`)

`artifacts`
- `id uuid pk default gen_random_uuid()`
- `slug text not null` — unique among non-deleted rows (partial unique index `where deleted_at is null`);
  `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`; generated from the title when omitted, suffixed `-2`, `-3`
  on collision; editable
- `title text not null`, `description text`
- `is_public boolean not null default false`
- `project_id uuid null → projects.id` (on delete set null)
- `conversation_id uuid null → conversations.id` — the chat it was published from (on delete set null)
- `current_version_id uuid null → artifact_versions.id`
- `created_at`, `updated_at`, `deleted_at` timestamptz (soft delete)

`artifact_versions`
- `id uuid pk`, `artifact_id uuid not null → artifacts.id` (cascade), `version int not null`
  (unique per artifact, 1-based)
- `manifest jsonb not null` — `Record<path, { sha256, size, contentType }>`; paths are normalised
  POSIX, relative, no `..`, no leading `/`, no empty segments
- `entry text not null default 'index.html'` — must exist in the manifest
- `spa_fallback boolean not null default false`
- `total_bytes int not null`
- `created_at timestamptz`

Types exported as `Artifact`, `NewArtifact`, `ArtifactVersion`. Migration via `pnpm db:generate`.

**Limits** (constants in `packages/core/src/lib/artifacts/limits.ts`): 25 MB total per version, 500
files, 10 MB per file. Content type comes from an extension allowlist (html, htm, js, mjs, css, json,
map, txt, csv, svg, png, jpg, jpeg, gif, webp, avif, ico, woff, woff2, ttf, wasm, mp3, mp4, webm);
anything else is rejected with an error naming the file.

## 4. Service (`packages/core/src/lib/artifacts/service.ts`)

One module owns all writes; tools and API routes call it.

- `publishArtifact({ slug?, title?, description?, files, entry?, spaFallback?, isPublic?, projectId?,
  conversationId?, merge? })`
  - `files: Array<{ path, content: Buffer|string }>`. Each blob is `put` into storage (dedup by sha).
  - New slug → create the artifact + version 1.
  - Existing slug, `merge: false` (default) → the manifest is exactly `files`.
    `merge: true` → `files` overlay the current manifest.
  - If the resulting manifest differs from the current one **only under `data/`**, the current version's
    manifest is updated in place (D4). Otherwise a new version is created and `current_version_id`
    moves.
  - Validates paths, limits, content types, and that `entry` exists. Returns
    `{ artifact, version, url, created: boolean, newVersion: boolean }`.
- `editArtifact(id|slug, { title?, description?, slug?, isPublic?, projectId?, rollbackTo?: number })`
  — rollback moves `current_version_id` to an existing version (no copy).
- `listArtifacts({ projectId?, limit? })`, `getArtifact(slug)`, `deleteArtifact(id)` (soft delete; blobs
  are left for now — they're content-addressed and may be shared).
- `readWorkspaceDir(workspaceId, path)` (in `lib/sandbox/fs-ops.ts` or beside it) — walks a sandbox
  directory, skipping symlinks and dot-directories, enforcing the limits *while* walking (stop at the
  first breach, don't read 2 GB to then reject it), and returns `files`.

## 5. Serving (`server/routes/artifact/[slug]/[...path].ts`)

Outside `/api`, so the `/api` auth middleware doesn't apply; this route does its own checks.

Routing:
- `/artifact/<slug>` → 301 to `/artifact/<slug>/` (so relative asset URLs resolve under the slug).
- `/artifact/<slug>/<path>` → look `path` up in the current version's manifest (empty path → `entry`).
  A miss serves `entry` when `spa_fallback` is set and the path has no extension, else 404. Only
  manifest paths are servable, so traversal is impossible by construction.
- Unknown or deleted slug → 404 (same response for private-and-unauthorised, so slugs don't leak).

Private artifacts:
- The sandboxed document is an opaque origin, so its subresource requests are cross-site and the
  better-auth cookie (SameSite=Lax, the default) is **not** sent. Hence:
  1. A request to `/artifact/<slug>/…` for a private artifact checks the session cookie (sent on a
     top-level navigation). No session → 302 to `/login?redirect=/artifact/<slug>/`. Session → 302 to
     `/artifact/<slug>/~<token>/<same path>`.
  2. `<token>` = base64url(`artifactId.expiresAt`) + `.` + HMAC-SHA256 over it with a key derived from
     `BETTER_AUTH_SECRET` (domain-separated: `"artifact-view:v1"`); TTL 12 h.
  3. `/artifact/<slug>/~<token>/<path>` verifies the token (artifact id must match the slug's row,
     not expired, constant-time compare) and serves without a session. Expired/invalid → 302 back
     through step 1 for a navigation (`Sec-Fetch-Dest: document`), 403 otherwise.
- Public artifacts ignore any `~<token>` segment and serve directly.
- **Verify first** in the build: confirm in a real browser that a sandboxed private page's JS/CSS/data
  fetches fail without the token and succeed with it. If the cookie *is* sent, keep the token anyway
  (it's also what the in-app iframe uses) but record the finding.

Headers on **every** artifact response (including 404s and redirects):
- `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads`
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (no `Cross-Origin-Resource-Policy`
  — the opaque-origin document must be able to load its own assets)
- `Content-Type` from the manifest
- Private: `Cache-Control: private, no-store`. Public: `Cache-Control: public, max-age=60` (content is
  mutable at a stable URL; Pangolin/Cloudflare sit in front).

Streams the blob from storage (same as `/api/i/[slug]`). `HEAD` supported.

## 6. Agent tools (`packages/core/src/lib/agent/tools/artifacts.ts`, toolset `artifacts`)

New on-demand toolset: `artifacts: { core: false, description: 'publish an HTML page or built webapp as
a viewable artifact (dashboards, demos, visual previews), or list/edit/delete artifacts' }`.

- `publish_artifact` — kind `create`, `outbound` when `public: true`, `taints` none.
  Args: `{ slug?, title, description?, html? | files?: Record<path,string> | workspace_path?, entry?,
  spa_fallback?, public?: boolean (default false on create, unchanged on update), project?, merge? }`.
  Exactly one of `html` / `files` / `workspace_path`. `html` → `{ 'index.html': html }`.
  `workspace_path` resolves against the run's workspace (error if there isn't one). Returns the URL,
  version, and whether it was in-place. `undo` → restore the previous `current_version_id` (or soft
  delete if it created the artifact). `display` → the chat artifact card (§7).
  Description tells Bridget: build first (`pnpm build` / `vite build` with `base: './'`), publish the
  output directory, use relative asset paths, put refreshable data in `data/*.json` and fetch it
  relatively, and that pages can't use `localStorage`/cookies.
- `edit_artifact` — kind `create`; `outbound` when it sets `public: true`. Title/description/slug/
  visibility/project/`rollback_to`.
- `list_artifacts` — kind `read`.
- `delete_artifact` — kind `destructive` (soft delete; undo restores).

MCP: the `artifacts` toolset is **not** in `MCP_EXCLUDED_TOOLSETS`, so Claude Code sessions can publish
with `html`/`files` (`workspace_path` returns a clear error there — no workspace).

Data refresh: no new scheduler. Bridget creates a normal job (`create_job`) whose prompt regenerates the
data and calls `publish_artifact({ slug, files: { 'data/x.json': … }, merge: true })`.

## 7. UI

- **API** (`server/api/artifacts/`, session/bearer-gated by the existing middleware): `GET /` list,
  `GET /:id` (with versions), `PATCH /:id` (edit/visibility/rollback), `DELETE /:id`,
  `GET /:id/view-url` → a fresh tokenised URL (public → plain URL). All writes go through the service.
- **Live updates:** artifacts are a live resource (follow the `add-live-resource` skill — vue-query
  reads + `publishChange` on every service write, including agent publishes from the worker).
- **`/artifacts` page** (Nuxt UI): table/grid of title, slug, project, visibility toggle (`USwitch`),
  version count, updated, actions (open, copy link, delete). Nav entry in the sidebar.
- **`/artifacts/[id]` detail:** sandboxed iframe preview (`<iframe sandbox="allow-scripts allow-forms
  allow-popups allow-modals allow-downloads" src="<view-url>">`), metadata edit, version history with
  rollback, links to project and source conversation.
- **Chat card:** `publish_artifact`'s `display` renders a card in the message with title, visibility
  badge, an inline iframe preview (same sandbox attrs, view-url), and "Open" / "Copy link".

## 8. Error handling

- Tool validation errors are returned to the model as plain messages naming the offending path/limit
  (e.g. `dist/video.mov: content type not allowed`, `bundle exceeds 25 MB at dist/assets/x.js`,
  `entry index.html not found — did you publish the build output dir?`).
- Publishing to an existing slug is the update path, not an error; the tool result says
  "updated v3 → v4" (or "data updated in place, v4") so Bridget notices if she overwrote by accident.
- Storage write failures abort the publish before any DB row changes (blobs first, then one DB
  transaction for artifact + version).

## 9. Testing

- **Unit (vitest):** path normalisation/rejection (`..`, absolute, empty segments, backslashes);
  manifest lookup, entry, SPA fallback (extension-less only); limits and content-type allowlist;
  `data/`-only diff → in place vs new version; merge vs replace; rollback; token sign/verify/expiry/
  wrong-artifact/tamper; slug generation + collision suffix; outbound flag only when making public.
- **Route tests:** headers present on 200/404/redirect; private without session → login redirect;
  with session → token redirect; valid token serves; expired token behaviour; deleted → 404;
  private-unauthorised and missing return identical 404s where applicable.
- **Isolation proof (must go red when the `sandbox` CSP is removed):** a fixture artifact whose JS
  tries `document.cookie`, `fetch('/api/tasks', { credentials: 'include' })`, and `localStorage`, and
  writes the outcomes into the DOM; playwright asserts all three fail.
- **Browser (playwright-cli, per `browser-testing` skill):** public artifact logged out; private logged
  out → login → back to artifact; private logged in renders with JS + `data/x.json`; a Vite-built app
  published via `workspace_path` works incl. SPA fallback; `/artifacts` toggle flips visibility live;
  chat card preview renders.
- **Agent eval:** add an eval case (cycle 85 substrate) — "build a small chart of X and show me" →
  expects `publish_artifact` in the tool log and a URL in the reply.

## 10. Out of scope

Live query API for artifacts; backends/server code; per-artifact custom domains or subdomains;
blob garbage collection for deleted artifacts; list thumbnails; artifact comments/collaboration.

## 11. Docs

New wiki page `docs/wiki/artifacts.md` (mirrored to MyMind), handover, roadmap row for cycle 87,
BACKLOG entries for §10 items.
