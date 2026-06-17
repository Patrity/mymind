---
title: Projects
status: shipped
cycle: 25
phase: 2
updated: 2026-06-16
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
`UpdateProjectInput` accepts `slug?`. When the slug **changes**, `updateProject` (in a `db.transaction`): (1) verifies the new slug is free (else throws → the PATCH endpoint maps it to **409**, surfaced as an inline field error in the modal); (2) updates the `projects` row; (3) **cascades** the rename to the denormalized slug columns — `UPDATE sessions/tasks/memories SET project = <new> WHERE project = <old>` — so the dashboard tabs (which filter by slug) keep showing the project's rows. The canonical `project_id` (uuid) columns are **not** touched. The PATCH endpoint emits `publishChange` for `project` always, and additionally for `session`/`task`/`memory` on a slug change so their lists refetch cross-tab. The slug zod is `^[a-z0-9]+(?:-[a-z0-9]+)*$` (matches `slugify` output).
