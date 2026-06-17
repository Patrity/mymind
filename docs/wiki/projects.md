---
title: Projects
status: shipped
cycle: 27
phase: 3
updated: 2026-06-17
---

# Projects

Canonical project entities that sessions and (agent) memories hang off of. A project is matched primarily by its **git remote** — the same repo cloned to many machines/paths still resolves to one project — so the agent's work, memories, and (later) docs/tasks all roll up to a single durable identity. Phase 1 ships the data model + resolution + ingest wiring + backfill; richer project features are deferred (see end).

## Data model (`server/db/schema/projects.ts`)
- `projects`: uuid `id` PK (`gen_random_uuid()`), `slug` (unique, `projects_slug_uidx`), `name`, `description` (default `''`), `active` (default `true`), `git_remote_key` (**canonical match key**, `host/owner/repo` lowercased — see below), `repository_url` / `production_url` / `staging_url`, `aliases text[]` (extra remote keys that resolve here), `local_paths text[]` (observed `cwd`s), `details jsonb` (free-form KV, default `{}`), `last_activity_at`, `created_at` / `updated_at`. Indexes: unique slug, plain index on `git_remote_key`, and a **partial unique** index `projects_git_remote_key_uidx ON (git_remote_key) WHERE git_remote_key IS NOT NULL` (so many rows may have a null key, but a non-null key is unique).
- The seeded **`uncategorized`** row (migration 0019): the fallback bucket for sessions with no parseable git remote. Never auto-created twice.
- `sessions.project_id` (uuid FK, indexed `sessions_project_id_idx`) — set on ingest. The legacy `sessions.project` text slug is kept in sync alongside it.
- `memories.project_id` (uuid FK, indexed `memories_project_id_idx`) — **null means global / project-agnostic** (user/world memories). Only `agent`-scope memories carry a project.
- `memories.source_date` (timestamptz) — "last observed" date for the memory, sourced from its session's `started_at`.

## Resolution — `findOrCreateProject` (`server/services/projects.ts`)
Given `{ gitRemote, cwd }`:
1. `normalizeGitRemote(gitRemote)` → canonical key, or `null`. **No key →** derive the cwd basename, slugify it, and match an existing project by `slug` OR `aliases @> [label]`/`[lslug]` (so a non-git `…/bridget-services` session resolves to the friendly-named project that has `bridget-services` as a slug/alias); only if nothing matches → the seeded **Uncategorized** row. (Cycle 25 — this label path **matches only, never creates**; creation stays git-remote-only.)
2. Match an existing project by `git_remote_key`.
3. Else match by `aliases` (`@>` array contains the key).
4. On a hit: append `cwd` to `local_paths` if new, bump `last_activity_at`, return.
5. Else **create**: slug = `nextUniqueSlug(slugify(repoNameFromKey(key)))`, `name` = repo name, `git_remote_key` = key, `repository_url` = raw remote, `local_paths` = `[cwd]`. A unique-race on `git_remote_key` (another concurrent ingest won) is caught and falls back to re-selecting the winner — **race-safe**.

The pure key helpers live in `server/lib/projects/git-remote.ts`:
- `normalizeGitRemote(remote)` — strips scheme/credentials/port/`.git`, handles scp-style `git@host:owner/repo`, lowercases → `host/owner/repo` (or `null`).
- `repoNameFromKey(key)` — last path segment.
- `nextUniqueSlug(base, taken)` — `base`, `base-2`, `base-3`, … first free.

## Wiring
- **Session ingest** (`upsertSession`, `server/services/sessions.ts`): when an event carries git/cwd, resolves `project_id` via `findOrCreateProject` on the event path and writes both `project_id` and the legacy `project` slug.
- **Memory enrichment** (`server/services/memory-enrich.ts` + resolve): sets `project_id` **by scope** — `agent` memories inherit their source session's project; `user` / `world` memories stay `null` (global). `source_date` = the source session's `started_at` ("last observed"), advanced via SQL `greatest(...)` when new evidence merges into an existing memory.
- The enrichment **selector excludes sessions whose project is `active=false`** (archived projects stop generating new memories).

## Backfill — `scripts/backfill-projects.ts`
Idempotent one-shot migration of existing data. For every session: resolve its canonical `project_id` (same key logic as the service, creating real projects from observed remotes) and write `project_id` + the matching `project` slug. Then for every memory: derive `project_id` (scope-based — `agent` → its session's project, else `null`) and `source_date` (= the session's `started_at`). Run:
```bash
node_modules/.bin/tsx --env-file=.env scripts/backfill-projects.ts
```
Re-runnable: a second run changes nothing (no duplicate projects, stable counts). Verified on the dev DB (2026-06-16): 463 sessions all resolved (real projects `mymind`, `bridget-services`, `hermes-agent` materialized from remotes), 1628/1633 memories dated (the 5 undated have no session).

## Deferred (later phases)
Phase 1 deliberately leaves these for follow-up cycles:
- **Project merge** (fold one project into another, re-point sessions/memories).
- **Document & task association** to projects.
- **Auto-move docs** into `/Projects/<name>/` on association.
- The **`details` KV editor** (column exists; no UI yet).

---

## Cycle 25 — projects UI + color

### Color column and palette utility

Migration `0020_tired_nebula.sql` adds a single `color text` nullable column to `projects`. A null value means "use the automatic default" — no manual work is required for a project to have a colour.

The pure utility `app/utils/project-color.ts` exports:
- **`PROJECT_PALETTE`** — 14 Tailwind-500 hex values (`#ef4444` … `#ec4899`) covering the full hue wheel, chosen to read well on the dark theme — these are the **opt-in** colours.
- **`NEUTRAL_COLOR`** — `#9ca3af`, the grey **default** every project uses until the user picks a colour.
- **`projectColor(slug, override?): string`** — pure: `return override || NEUTRAL_COLOR`. So a project is grey by default; setting `color` (an override) gives it a palette hue. (No auto-assignment — `slug` is kept in the signature for callers but unused.)

### `<ProjectBadge>` component

`app/components/ProjectBadge.vue` renders a coloured pill with a dot, a truncated label, and an optional link.

Props: `slug` (required), `name?`, `color?`, `to?: string | null`. Link behaviour: **absent `to` → deep-links to that project's dashboard** `/projects/<slug>`; an explicit string overrides the target; **`to = null` renders a plain `<span>`** (no link). The type is `string | null` (not `string | false`) on purpose — a Boolean in the prop type makes Vue cast an *absent* `to` to `false`, which is indistinguishable from an explicit no-link; `null` keeps "absent" (→ dashboard) and "no link" distinct. The link element is the real `NuxtLink` component resolved via `resolveComponent` (passing the string `'NuxtLink'` to `<component :is>` renders an inert `<nuxtlink>` custom element, not an `<a>`).

Colour resolution order (first truthy wins):
1. Explicit `color` prop.
2. `useProjects().useProjectColors().map` — a `computed` Map derived from the vue-query project list cache (`slug → color | null`). This propagates a custom override saved on `/projects` to every surface that renders a badge without needing a separate fetch.
3. `projectColor(slug)` → the grey `NEUTRAL_COLOR` default.

Styling uses inline `style` bindings (not Tailwind classes) so arbitrary hex values work: `color`, `backgroundColor` (`hex + '1f'` for 12 % alpha fill), and `borderColor` (`hex + '40'` for 25 % alpha border).

Surfaces that use `<ProjectBadge>`: memories list (deep-links to the dashboard) and session detail (deep-links); the `/projects` rows, dashboard header, task cards, and the edit-modal preview pass `:to="null"` (plain pill — the row/page handles navigation itself).

### Expanded `ProjectDTO` and list API

`ProjectDTO` (`shared/types/tasks.ts`) now exposes the full project model:
- Core: `id`, `slug`, `name`, `description`, `active`, `color`
- Git: `gitRemoteKey`, `repositoryUrl`, `productionUrl`, `stagingUrl`, `aliases`, `localPaths`, `lastActivityAt`
- Counters (computed in SQL): `sessionCount`, `memoryCount`, `taskCount`

`listProjects` and `getProject` (`server/services/projects.ts`) share a `COUNT_COLUMNS` set of count subqueries so both return session/memory/task counts in a single round-trip with no N+1. **All three count by the denormalized `project` slug string** (`where x.project = projects.slug`), NOT the canonical `project_id` — this is the same key the dashboard tabs and every `?project=` filter use, so the header counts always match what the tabs display even when a row's slug and `project_id` have drifted (legacy vs canonical projects coexist until phase-3 merge).

### `/projects` page

The projects index page surfaces all `ProjectDTO` fields per row:
- Coloured `<ProjectBadge>` for each project.
- Git remote key, repository/production/staging URLs.
- Session and memory counts.
- Last-activity timestamp.

An **Edit modal** per project provides:
- Repository URL, production URL, staging URL text inputs.
- Aliases multi-value input (`UInputTags`).
- A **colour swatch picker**: a leading grey **"Default"** swatch (sets `color = null` → the neutral grey) followed by the 14 `PROJECT_PALETTE` hues; the active swatch is ring-highlighted (grey when `color` is null).
- Read-only display of `gitRemoteKey` and `localPaths`.

Saving calls `PATCH /api/projects/:slug` with `{ color, repositoryUrl, productionUrl, stagingUrl, aliases, slug? }`. On save the vue-query cache is invalidated, causing all `<ProjectBadge>` instances across the app to re-resolve via the shared `useProjectColors()` map.

The Edit modal lives in a reusable component **`app/components/ProjectEditModal.vue`** (`v-model:open`, `:project`, `@saved`/`@deleted`), used by both `/projects` and the dashboard. It owns its own success/error toasts; consuming pages just refetch/navigate on the events.

---

## Project dashboard `/projects/[slug]` + editable slug

### Routing & pages
The route is keyed on **slug** (`getProject(slug)` and every `?project=<slug>` filter already key on the slug, so the route param feeds straight into the header fetch and all three tab fetches — zero extra lookups). `app/pages/projects.vue` was split into `app/pages/projects/index.vue` (the list) + `app/pages/projects/[slug].vue` (the dashboard). Clicking a project row on `/projects` navigates to its dashboard (the active toggle and edit button `@click.stop` so they don't trigger navigation).

### Dashboard (`app/pages/projects/[slug].vue`)
- **Data:** `useProjects().useProject(slug)` (vue-query key `['project', slug]`, live-invalidated by the `{resource:'project'}` event). Loading → skeletons; 404/null → a "Project not found" state with a back link.
- **Header:** `<ProjectBadge :to="null">`, description, and a metadata grid — git remote key, repository/production/staging URLs as external links (`target=_blank rel=noopener`, rendered only when set), aliases as badges, `localPaths` (mono), and created/updated/last-active dates.
- **Stats row:** Sessions · Memories · Tasks (`sessionCount`/`memoryCount`/`taskCount` from the one `getProject` fetch — counted by slug, see above).
- **Tabs** (`UTabs`): Sessions | Tasks | Memories, each reusing the existing filtered list hooks (`useSessionList({project})`, `useTaskList(slug)`, `useMemoryList({project})`) with loading/empty/error states. Session rows deep-link to `/sessions/[id]`; task/memory rows have no per-item detail page (link to `/tasks` / `/memories`).
- **Edit:** header Edit button opens `<ProjectEditModal>`; on `saved` with a changed slug the page `navigateTo`s the new `/projects/<newslug>` URL (`replace: true`); on `deleted` it returns to `/projects`.

### Editable slug + cascade rename (`updateProject`)
`UpdateProjectInput` accepts `slug?`. When the slug **changes**, `updateProject` (in a `db.transaction`): (1) verifies the new slug is free (else throws → the PATCH endpoint maps it to **409**, surfaced as an inline field error in the modal); (2) updates the `projects` row; (3) **cascades** the rename to the denormalized slug columns — `UPDATE sessions/tasks/memories SET project = <new> WHERE project = <old>` — so the dashboard tabs (which filter by slug) keep showing the project's rows. The canonical `project_id` (uuid) columns are **not** touched. The PATCH endpoint emits `publishChange` for `project` always, and additionally for `session`/`task`/`memory`/`document` on a slug change so their lists refetch cross-tab. The slug zod is `^[a-z0-9]+(?:-[a-z0-9]+)*$` (matches `slugify` output).

---

## Document association (cycle 26) — the path⟺project invariant

Documents associate with projects by **filing**, not by a creation-time signal (a doc write — manual, quick-capture, OCR spin-off, transcription — carries no git/cwd). The rule:

> A document is associated with project *X* **iff** its `documents.path` is under **`/projects/<X-slug>/`** (lowercase — a doc-tree path string, NOT the Nuxt route `/projects/[slug]`).

The **path is the single source of truth**; the row stores the resolved `project_id` (uuid FK, migration 0021) + the denormalized `project` slug, both **derived from the path on every write** and kept in lock-step with it.

### The resolver + choke point
- Pure `projectFromPath(path)` (`server/lib/projects/doc-path.ts`) → the `<seg>` from `^/projects/<seg>/` (trailing-slash boundary required), else null.
- `matchProjectByLabel(label)` (`server/services/projects.ts`) → matches an existing project by slug/alias/slugified-name; **match-only, never creates** (creation stays git-remote-only). Extracted from `findOrCreateProject`'s no-git branch.
- `createDoc`/`updateDoc` (`server/services/documents.ts`) funnel every path/project change through `resolveDocProjectFromPath(finalPath)`. Precedence: if the input carries a `project` slug and the path isn't already under `/projects/<slug>/`, the doc is **relocated** to `/projects/<slug>/<basename>` (assign-project files it); then `project_id`+`project` are derived from the final path. **The path always wins** — passing `project` only relocates; to un-associate, move the doc out of `/projects/`.

### Three triggers (all enforce the invariant)
1. **Manual move** — moving a doc into/out of `/projects/<x>/` associates/clears it.
2. **Assign-project** — setting `project=X` (API/UI) files the doc under `/projects/<X-slug>/`.
3. **`/input` enrichment** — `buildEnrichMessages` feeds the active project list to the proposer, which classifies the doc into a real slug (or null) and proposes `path = /projects/<slug>/<filename>`. The proposal rides the **existing** `review_queue` → approve flow (`approve.post.ts` already applies `project` + moves to `path`); the move-listener then resolves `project_id`. No new auto-apply mechanism.

### Slug-rename cascade
`updateProject`'s rename transaction (above) also rewrites associated docs: `path` prefix `/projects/<old>/…` → `/projects/<new>/…` and the `project` slug, `WHERE project_id = <id>` (`project_id` unchanged). The SQL `regexp_replace('^/projects/<old>/', …)` mirrors the unit-tested pure `rewriteProjectPathPrefix`.

### Surfacing
- `documents.project_id` (migration 0021, nullable FK → `projects.id`, indexed; backfilled from the `project` slug).
- `ProjectDTO.documentCount` via the shared `COUNT_COLUMNS` (count by slug **and** `deleted_at is null`). The same commit fixed `taskCount`/`memoryCount` to exclude soft-deleted/archived rows so every stat matches its tab's `live()` filter (sessions hard-delete, so unchanged).
- `listDocs({ project })` + `GET /api/documents?project=<slug>` + `useDocList(slug)` (vue-query, reactive key).
- A **Documents tab** on `/projects/[slug]` (4th tab) + a Documents stat cell.
- The image-OCR → document spin-off now emits `publishChange({ resource: 'document', … })` (previously the only doc write path missing it).

### Not yet
- Tree/search `?project=` filtering (the dashboard uses the flat `listDocs`; tree/search filtering deferred).
- Per-document deep-link route (`?doc=<id>`) — doc rows link to `/documents`.
- The `documentCount` **stat badge** doesn't live-update on a doc move (only the tab list does) — same as the sibling counts (no write emits a `project` event); a cross-cutting follow-up.

---

## Project merge (cycle 27) — folding a duplicate into its canonical twin

Phase 1's history import grouped sessions by cwd-label when no git remote was recorded, so **legacy label projects coexist with their git-keyed twins** (`gpx-workflows` ↔ `gpx-workflows-2`, `portfolio-v2` ↔ `portfolio-v2-2`, etc.). Merge folds a **loser** L into a **winner** W and deletes L.

### `mergeProjects(loserSlug, winnerSlug)` (`server/services/project-merge.ts`)
One `db.transaction`:
1. **Guards** (throw → endpoint maps to HTTP): loser/winner must exist (`MERGE_NOT_FOUND` → 404); not the same project (`MERGE_SELF` → 400); neither is `uncategorized` (`MERGE_UNCATEGORIZED` → 400).
2. Capture `repointedMemoryIds` (the loser's live memories — fed to the dedup pass).
3. **Repoint** every reference, matched by **`project_id = L.id` OR the denormalized `project = L.slug`** (catches drift): `sessions`/`memories` set `project_id = W.id, project = W.slug`; `tasks` set `project = W.slug` (slug-only — no `project_id`).
4. **Documents — row-by-row** (a merge brings two doc trees together, so paths can collide): for each loser doc, `rewriteProjectPathPrefix(path, L.slug, W.slug)` then `uniquifyPath(newPath, takenSet)` (collision → `…-2.md`/`-3`; the doc's own old path is freed from `takenSet` first). Repoint `project_id`+`project`+`path`.
5. **Absorb L's identity into W** so future ingests that matched L now resolve to W: `W.aliases = mergeStringArrays(W.aliases, [L.slug, ...L.aliases, ...(L.gitRemoteKey && !W.gitRemoteKey ? [L.gitRemoteKey] : [])])`; merge `local_paths`; `last_activity_at = max(W, L)`.
6. **Hard-delete L** (all FK refs repointed → the `ON DELETE NO ACTION` FK is satisfied; the slug frees up but lives on as a W alias).

Returns `{ winner, repointedMemoryIds }`. Emits (in the endpoint): `project` deleted (L) + `project` updated (W) + `session`/`task`/`memory`/`document` updated.

### Post-merge memory dedup (`dedupMemoriesAfterMerge`, `server/services/memory.ts`)
After the transaction, the loser's repointed memories may duplicate the winner's. **Reuses the existing `createMemory` dedup machinery** — the extracted `buildDedupCandidates({contentHash, embedding, scope, project, excludeId})` (exact-hash global + near-vector scoped to `(scope, project)`) + `dedupDecision`. For each repointed memory, processed **sequentially** (so an earlier archive is `live()`-invisible to a later candidate build, avoiding mutual-archive): `skip`/`merge` → archive it (`archivedAt`, `supersededBy`) + append its evidence to the survivor. (The deterministic near-neighbor/hash dedup; the LLM relationship-judge layer is a deferred enhancement.)

### Endpoint + UI
`POST /api/projects/[slug]/merge` `{ targetSlug }` (the `[slug]` is the loser). Dashboard `/projects/[slug]` has a secondary **"Merge"** action → `<ProjectMergeModal>`: a target `USelectMenu` (excludes self + `uncategorized`), a preview of counts that will move, a destructive "**{loser}** will be permanently deleted" warning, and an `error`-coloured Merge button → navigates to the winner. **Hard-delete is final; no undo** (the confirm dialog is the guard).

### Watch-out — schema/DB FK divergence
The three `project_id` FK constraints exist in **prod** (raw SQL in migrations 0019/0021, `ON DELETE NO ACTION`) but are **not modeled** in the Drizzle schema files (declared as bare `uuid`). A future `pnpm db:generate` could emit a migration that *drops* them — **review any generated migration touching these FKs**. (Same class as the existing partial-unique/GIN snapshot drift.) Modeling them with `.references()` is a backlog item.
