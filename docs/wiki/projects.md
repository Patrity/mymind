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

Props: `slug` (required), `name?`, `color?`, `to?` (default `'/projects'`; pass `false` to suppress the link).

Colour resolution order (first truthy wins):
1. Explicit `color` prop.
2. `useProjects().useProjectColors().map` — a `computed` Map derived from the vue-query project list cache (`slug → color | null`). This propagates a custom override saved on `/projects` to every surface that renders a badge without needing a separate fetch.
3. `projectColor(slug)` → the grey `NEUTRAL_COLOR` default.

Styling uses inline `style` bindings (not Tailwind classes) so arbitrary hex values work: `color`, `backgroundColor` (`hex + '1f'` for 12 % alpha fill), and `borderColor` (`hex + '40'` for 25 % alpha border).

Surfaces that use `<ProjectBadge>`: memories list/detail, sessions detail, and tasks cards.

### Expanded `ProjectDTO` and list API

`ProjectDTO` (`shared/types/tasks.ts`) now exposes the full project model:
- Core: `id`, `slug`, `name`, `description`, `active`, `color`
- Git: `gitRemoteKey`, `repositoryUrl`, `productionUrl`, `stagingUrl`, `aliases`, `localPaths`, `lastActivityAt`
- Counters (computed in SQL): `sessionCount`, `memoryCount`

`listProjects` (`server/services/projects.ts`) inlines two count subqueries so the list endpoint returns session and memory counts in a single round-trip with no N+1.

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

Saving calls `PATCH /api/projects/:slug` with `{ color, repositoryUrl, productionUrl, stagingUrl, aliases }`. On save the vue-query cache is invalidated, causing all `<ProjectBadge>` instances across the app to re-resolve via the shared `useProjectColors()` map.
