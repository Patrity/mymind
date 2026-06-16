---
title: Project-Association Foundation (Phase 1) — canonical projects, git-remote matching, memory source_date
cycle: 23
date: 2026-06-16
status: shipped
branch: feat/project-association
spec: ../superpowers/specs/2026-06-16-project-association-foundation-design.md
plans:
  - ../superpowers/plans/2026-06-16-project-association-foundation.md
wiki:
  - ../wiki/projects.md
  - ../wiki/memory.md
  - ../wiki/sessions.md
shipped:
  - "Pure helpers `server/lib/projects/git-remote.ts` — `normalizeGitRemote` (ssh↔https, strip scheme/creds/port/.git, lowercase → `host/owner/repo`; null when unparseable), `repoNameFromKey`, `nextUniqueSlug`. And `server/lib/projects/memory-project.ts` — `projectIdForScope` (agent → session project, user/world → null). Unit-tested (5 new tests; suite 315 → 320)."
  - "Migration 0019 — `projects` rewritten to a surrogate **uuid `id` PK** (slug stays unique), + `git_remote_key` (partial-unique WHERE not null), `repository_url`/`production_url`/`staging_url`, `aliases[]`, `local_paths[]`, `details jsonb`, `last_activity_at`. `active` boolean KEPT (see Decisions). Seeded `uncategorized` row. `sessions.project_id` (FK) + `memories.project_id` (FK, null=global) + `memories.source_date`. drizzle-kit botched the PK swap; the projects portion was hand-written (DROP old pkey → ADD id pkey), partial-unique + GIN hand-appended."
  - "`findOrCreateProject` (`server/services/projects.ts`) — normalize git remote → match `git_remote_key` → match `aliases @>` → race-safe create (catch unique-race, re-select) → Uncategorized for no-remote. Existing CRUD untouched."
  - "Session ingest wired (`upsertSession`): when an event carries git/cwd (the `/api/hooks/cc/[event]` path), resolves `project_id` + keeps the legacy `project` slug in sync. Transcript path (no git) never clobbers `project_id`."
  - "Memory enrichment wired (`memory-enrich.ts` + `memory-resolve.ts`): `project_id` set **by scope** (agent → session project, user/world → null); `source_date` = source session `started_at` (\"last observed\", advanced via SQL `greatest` on evidence merge); evidence entries gain `sessionDate`; near-neighbour dedup buckets on `project_id`; the candidate selector now excludes archived projects via a `project_id`+`active` join (replacing the old slug-string `not in`)."
  - "Backfill `scripts/backfill-projects.ts` (idempotent) — resolves every session's `project_id` and derives memory `project_id`+`source_date`. Verified on dev: **463/463 sessions resolved**, real projects materialized from remotes (`github.com/tony/mymind`, `bridget-services`, `hermes-agent`), 1628/1633 memories dated, stable on re-run."
  - "Wiki: new `projects.md`; `memory.md` + `sessions.md` updated. Gates green (typecheck 0 / test 320 / build). Final integration review: READY TO MERGE, no blocking issues."
decisions:
  - "**Git-remote-keyed identity.** Match on the normalized git remote (robust across machines/worktrees); non-git sessions → a seeded Uncategorized project. Surrogate uuid `id` PK chosen now (while data is tiny) so phase-3 merge is a clean FK-repoint and references never re-migrate."
  - "**Kept `projects.active` (deviation from spec).** The spec said replace `active` with `archived_at`; the existing projects CRUD + `/projects` UI (active toggle) depend on `active`, so swapping it was tangential churn. Selector uses the `project_id`+`active` join instead. User signed off."
  - "**Sequenced BEFORE the bulk enrich/import.** Enrichment's dedup/supersede is project-scoped; running the 457-session import under crude cwd-basename buckets would bake in wrong dedup decisions a re-label can't undo. So the `enrich-memories` cron is DISABLED on prod (commented in `nuxt.config.ts`) until this lands + backfill runs."
---

# Project-Association Foundation (Phase 1)

Canonical `projects` entities keyed on the git remote, with session ingest and memory enrichment resolving to real project ids, plus a memory `source_date` (when the work happened) so recency/supersession survive the bulk import. Built subagent-driven (7 tasks, two-stage review each + final integration review) on `feat/project-association`. Full behaviour: [wiki/projects.md](../wiki/projects.md).

## Where the next seam is
1. **Finish the branch** — merge `feat/project-association` to master (this handover is written pre-merge).
2. **Deploy + prod migrate + prod backfill.** Push triggers CI `db:migrate` (applies 0019 to prod). Then run `DATABASE_URL=<prod> node_modules/.bin/tsx scripts/backfill-projects.ts` to populate `project_id`/`source_date` on prod's existing rows.
3. **Re-enable enrichment + run the import.** Uncomment the `enrich-memories` cron in `nuxt.config.ts`; run the bridget import on prod (`scripts/migrate-bridget-sessions.ts`). Memories now bucket into canonical projects with correct `source_date`.
4. **Phases 2–3 (separate cycles):** project **merge** (e.g. fold the legacy slug-only `my-mind` into the git-keyed `mymind`); **document/task** project association; **auto-move** docs to `/Projects/<name>/`; project **UI/CRUD** + the `details` KV editor.

## Watch-outs
- **Snapshot drift (known):** `meta/0019_snapshot.json` omits the hand-appended partial-unique + GIN indexes (drizzle can't represent them) — the live DB has all four. A future `pnpm db:generate` may try to re-emit those two; review the next generated migration before applying (same pattern as the HNSW/GIN indexes elsewhere).
- **Per-event resolution cost:** `findOrCreateProject` runs on every git-bearing hook event incl. per-tool `PreToolUse`/`PostToolUse` (a `last_activity_at` write each). Fine at single-user scale; optimize later if noisy (e.g. only bump when stale, or resolve only on SessionStart/UserPromptSubmit).
- **Legacy vs canonical projects coexist** post-backfill (e.g. `my-mind` null-key + `mymind` git-keyed). Expected; phase-3 merge cleans it up. ~399 dev sessions are in `uncategorized` (transcript-only / no remote).
- **`memories.project` (slug string) is still written for all scopes** (pre-existing denormalization); canonical filtering keys off `project_id`, so it's cosmetic.
