---
title: Project-Association Foundation (Phase 1)
status: approved-brainstorm
cycle: 23
phase: 1 of 3
date: 2026-06-16
---

# Project-Association Foundation (Phase 1)

**Goal:** Introduce a canonical `projects` entity and a `findOrCreateProject` service keyed on the git remote, then wire **session ingestion** and **memory enrichment** to canonical project IDs. Fold in a memory **origin-date** fix. Merge, document association, auto-move, and project UI are explicitly later phases.

**Blocks:** re-enabling the `enrich-memories` cron and running the bulk bridget import on prod (both currently held — see `nuxt.config.ts`).

## Why

Today `session.project` is the **cwd basename** — fragile: the same repo at different paths or on different machines fragments into multiple "projects," and same-named directories collide. Memory enrichment's relationship-judge (dedup / supersede / contradict) is **project-scoped**, so running the 457-session bridget import + enrichment under crude buckets would bake in wrong dedup decisions that a later re-label **cannot** undo. This phase establishes correct, canonical project scoping *before* that bulk run.

Second, a latent bug: enriched memories carry `created_at = enrichment-run time`. Import old sessions and every memory is dated "now," destroying the temporal signal needed for recency ranking and supersede ordering. We add a `source_date` = when the work actually happened.

## Decisions (locked at brainstorm, 2026-06-16)

1. **Match key:** normalized **git_remote**; sessions with no remote → a seeded **Uncategorized** project.
2. **Identity:** surrogate **uuid `id` PK** + mutable `slug` + canonical `git_remote_key`. `session.project` (string) → `session.project_id` (FK) + backfill. Done once now while data is tiny.
3. **Memory project rule:** by **scope** — `agent` → the session's project; `user`/`world` → `null` (global/agnostic).
4. **`source_date`:** = **last observed** (`max` of evidence session start dates), not first-seen.

No hard FKs reference `projects` today (`sessions`/`memories`/`documents`/`tasks` all use a soft slug string), so the PK change is low-risk; `slug` stays unique for those soft refs during transition.

## Data model

### `projects` (rewrite — `server/db/schema/projects.ts`)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | `default gen_random_uuid()` (PG16 built-in, no extension) |
| `slug` | text unique not null | mutable, human/URL key, derived from repo name |
| `name` | text not null | |
| `description` | text not null default '' | |
| `git_remote_key` | text | canonical match key, e.g. `github.com/patrity/mymind`; **null** only for Uncategorized + manual-no-remote projects |
| `repository_url` | text | raw remote (for display/links) |
| `production_url` / `staging_url` | text | |
| `aliases` | text[] not null default '{}' | extra match keys (merge / manual mapping) |
| `local_paths` | text[] not null default '{}' | cwds seen across machines (informational + weak signal) |
| `details` | jsonb not null default '{}' | future arbitrary KV (UI later) |
| `last_activity_at` | timestamptz | bumped on session activity (list sort) |
| `archived_at` | timestamptz | **null = active**; replaces the old `active` boolean |
| `created_at` / `updated_at` | timestamptz not null default now() | |

**Indexes (hand-append to generated migration):** `unique(slug)`; **partial** `unique(git_remote_key) WHERE git_remote_key IS NOT NULL` (allows many nulls); `GIN(aliases)` for `@>` containment.

**Seed (in migration):** `{ slug:'uncategorized', name:'Uncategorized', git_remote_key:null }`.

**Migrating existing rows:** add `id` (gen_random_uuid per row); convert `active=false → archived_at=now()` then drop `active`; existing slugs kept.

### `sessions` (add)
- `project_id uuid references projects(id)` — nullable (backfill populates; app treats null defensively as Uncategorized). Keep existing `project` text in sync with the resolved project's slug (denormalized, back-compat). Index `project_id`.

### `memories` (add)
- `project_id uuid references projects(id)` — **nullable; null = global/agnostic**. Keep `project` text in sync. Index `project_id`.
- `source_date timestamptz` — last-observed source session date.
- `evidence` jsonb entries gain a `sessionDate` field (ISO) — no shape migration, populated going forward + backfilled.

## Components

### `normalizeGitRemote(remote: string | null): string | null` — pure, unit-tested
Rules: null/empty → null; strip `git@HOST:` / `ssh://git@HOST[:port]/` / `https://[user[:pw]@]HOST/` to `HOST/path`; strip port from host; strip trailing `.git` and `/`; lowercase the whole key.

Test vectors:
- `git@github.com:Patrity/mymind.git` → `github.com/patrity/mymind`
- `https://github.com/Patrity/mymind.git` → `github.com/patrity/mymind`
- `https://x-access-token:TOK@github.com/Patrity/mymind` → `github.com/patrity/mymind`
- `ssh://git@git.costanzoclan.com:2222/tony/foo.git` → `git.costanzoclan.com/tony/foo`
- `""` / null → null

### `findOrCreateProject({ gitRemote, cwd }): Promise<Project>` — `server/services/projects.ts`
1. `key = normalizeGitRemote(gitRemote)`.
2. If `key`:
   - match `git_remote_key = key`; else match `aliases @> ARRAY[key]`. On match: append `cwd` to `local_paths` if new, bump `last_activity_at`, return.
   - else `INSERT (slug=uniqueSlug(repoName(key)), name=repoName(key), git_remote_key=key, repository_url=rawRemote, local_paths=[cwd], last_activity_at=now()) ON CONFLICT (git_remote_key) DO UPDATE SET last_activity_at=now() RETURNING *` (race-safe), return.
3. Else (no key): return the **Uncategorized** row (by `slug='uncategorized'`); do not mutate it.

Helpers: `repoName(key)` = last path segment; `uniqueSlug(base)` = slugify; if taken by a *different* `git_remote_key`, suffix `-2`, `-3`, …

### Wiring (phase-1 scope)
- **Session ingest** — resolve in `upsertSession` (`server/services/sessions.ts`) when `git_remote`/`cwd` are provided (the `/api/hooks/cc/[event]` path supplies them). Set `project_id` (+ denormalized `project` slug). Do **not** clobber an existing `project_id` when an event lacks git info. The transcript path (`ingestTranscript`) carries no git data → leaves `project_id` untouched; backfill / a later event covers transcript-only sessions.
- **Memory enrichment** (`server/services/memory-enrich.ts` + `memory-resolve.ts`): on create, `project_id = scope==='agent' ? session.project_id : null`; `source_date = session.startedAt`. On evidence merge in `resolveEnrichedMemory`: `source_date = max(existing, session.startedAt)` and append `sessionDate` to the evidence entry.
- **Enrichment selector** (`runMemoryEnrichment`): replace the `project not in (select slug from projects where active=false)` string check with `not exists (select 1 from projects p where p.id = sessions.project_id and p.archived_at is not null)`.

### Backfill — `scripts/backfill-projects.ts` (idempotent, runs vs any `DATABASE_URL`)
- Each session → `findOrCreateProject(git_remote, cwd)` → set `project_id` (+ `project` slug).
- Each memory → `project_id` from its session's `project_id` if `scope='agent'` else null; `source_date` from the session's `started_at` (max across evidence sessions if multiple); add `sessionDate` to evidence entries.

## Migration specifics
`pnpm db:generate` then hand-append the partial-unique + GIN indexes, the FKs/indexes, the Uncategorized seed insert, and the `active → archived_at` conversion. `db:migrate` runs in CI on deploy (per cycle 16); the backfill script is run manually after (dev, then prod). PG16 `gen_random_uuid()` is built-in.

## Out of scope (phases 2–3)
Project **merge** (promote/repoint/delete); **document** & **task** project association (both already carry a soft `project` slug); **auto-move** docs to `/Projects/<name>/`; project **UI/CRUD**; the `details` KV editor; `session_count` denormalization (derivable; `last_activity_at` covers sorting).

## Testing
- **Unit:** `normalizeGitRemote` (all vectors above); `findOrCreateProject` (match by key, match by alias, create-new, Uncategorized for non-git, slug-collision → unique suffix); scope→`project_id` rule; `source_date` max-merge.
- **Integration:** session ingest with git → `project_id` set + project row created; enrichment sets `project_id` (agent) / null (user|world) + `source_date`; backfill populates sessions + memories correctly; enrichment selector excludes archived-project sessions.
- Gates: `pnpm typecheck` / `pnpm test` / `pnpm build`.

## Rollout
1. Migrate dev → run `backfill-projects` on dev → verify.
2. Deploy (migration in CI) → run `backfill-projects` on prod.
3. (Separate follow-up, not this phase's code) re-enable the `enrich-memories` cron + run the bridget import — now memories bucket into canonical projects with correct `source_date`.
