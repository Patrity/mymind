---
title: Document ↔ Project Association (Phase 2) — path⟺project invariant, filing, enrichment classify
cycle: 26
date: 2026-06-17
status: shipped
branch: feat/doc-project-association
spec: ../superpowers/specs/2026-06-17-document-project-association-design.md
plans:
  - ../superpowers/plans/2026-06-17-document-project-association.md
wiki:
  - ../wiki/projects.md
shipped:
  - "**Migration 0021** — `documents.project_id` (uuid FK → `projects.id`, nullable, indexed) + backfill from the `project` slug. Non-destructive/additive; prod self-migrates on deploy. (FK hand-added — drizzle-kit omits it; snapshot drift expected.)"
  - "**path⟺project invariant** — a doc is associated to X iff its `documents.path` is under **`/projects/<X-slug>/`** (lowercase; a doc-tree string, NOT the Nuxt route). Pure `projectFromPath` (`server/lib/projects/doc-path.ts`) + `matchProjectByLabel` (extracted from `findOrCreateProject`, **match-only/never-creates**). `createDoc`/`updateDoc` derive `project_id`+`project` from the FINAL path via `resolveDocProjectFromPath`; the path always wins — passing `project=X` **relocates** the doc to `/projects/X/<basename>` (assign-project). Three triggers: manual move, assign-project, and the `/input` enrichment classify."
  - "**Enrichment classify** — `buildEnrichMessages(doc, projects)` feeds the active project list to the proposer; it picks a real slug (or null) + proposes `path=/projects/<slug>/<filename>`. Rides the **existing** `review_queue`→`approve.post.ts` flow (already applies `project`+`path`); the move-listener resolves `project_id`. No review-schema or approve-path change."
  - "**Slug-rename cascade extended** — `updateProject`'s rename transaction now also rewrites associated docs (`path` prefix `/projects/<old>/`→`/projects/<new>/` + `project` slug, `WHERE project_id`), `project_id` unchanged. SQL `regexp_replace` mirrors the unit-tested pure `rewriteProjectPathPrefix`."
  - "**Surfacing** — `ProjectDTO.documentCount` (shared `COUNT_COLUMNS`, count by slug **and `deleted_at is null`**); the same fix made `taskCount`/`memoryCount` exclude soft-deleted/archived so each stat matches its tab's `live()` filter. `listDocs({project})` + `GET /api/documents?project=` + `useDocList(slug)`; a **Documents tab** + stat on `/projects/[slug]`. Image-OCR→doc spin-off now emits a `document` live event (was the only doc writer missing it)."
  - "**Hygiene:** vitest now excludes `.claude/**` — a leftover agent git-worktree under `.claude/worktrees/*` carried a duplicate `test/` dir that vitest double-discovered (inflated the suite 379→725). Real suite = **379** (64 files), typecheck 0, build OK."
  - "Built subagent-driven (6 tasks, two-stage review each + final opus whole-branch review: **Ready to merge — ship it**). **Playwright E2E PASS:** create-under-/projects/, file-from-/input (move-listener), assign-project (relocate) all set project_id; documentCount=3 matches the Documents tab; slug rename mymind→mymind-rt cascaded all 3 doc paths + restored; soft-delete drops the count to 0."
---

# Document ↔ Project Association (Phase 2, cycle 26)

Phase 2 of project association (item 2 of the projects roadmap). Documents now associate with canonical projects by **filing under `/projects/<slug>/`** — the path is the single source of truth, `project_id` is the stored canonical link. Built subagent-driven on `feat/doc-project-association`. Full behaviour: [wiki/projects.md](../wiki/projects.md#document-association-cycle-26--the-pathproject-invariant).

## Validation (playwright E2E, dev)
All three association mechanisms set `project=mymind` end-to-end: a doc created at `/projects/mymind/x.md`; a doc created in `/input/` then **moved** to `/projects/mymind/`; a doc created with `project:'mymind'` + a `/input/` path (**relocated** to `/projects/mymind/`). `documentCount=3` matched the Documents tab list. Renaming the project slug `mymind→mymind-rt` cascaded **all 3 doc paths** (old slug 404'd) and restored cleanly. Soft-deleting the 3 docs dropped `documentCount` to **0** (confirms the soft-delete count fix). Test docs cleaned up.

## Where the next seam is
- **Item 3 — Project merge (Phase 3):** fold a legacy label project into its git-keyed twin (`gpx-workflows`→`gpx-workflows-2`, `portfolio-v2`→`portfolio-v2-2`, `my-mind`→`mymind`, `bridget`/`command-center`→`bridget-services`). A true merge **repoints `project_id`** (sessions/memories/documents) + dedups + archives the loser — distinct from item-1's slug-rename (which keeps the same project row). The slug-rename doc-path cascade is reusable groundwork. Confirmed dupes still coexist in prod.
- **Doc surfacing follow-ups:** tree/search `?project=` filtering (the tab uses the flat `listDocs`); a per-doc deep-link route (`?doc=<id>`) so doc-tab rows open the editor directly (today → `/documents`).

## Watch-outs
- **`documentCount` stat badge isn't live** on a doc move — only the Documents tab list refetches (doc writes emit `document`, not `project`). Identical to `sessionCount`/`taskCount`/`memoryCount` — none emit a `project` event. Cross-cutting fix (emit `project` on child writes, or a count-override) deferred for all four.
- **Approve-path path-precedence edge** (`approve.post.ts`): it calls `updateDoc({project})` then `moveDoc(p.path)`. If the LLM picks `project:X` but proposes a `path` NOT under `/projects/X/`, step 2 moves the doc back out and clears the association (path wins, by design). The enrichment prompt steers the model to `/projects/<slug>/…`, so unlikely; a defensive guard (skip `moveDoc` when `project` already filed the doc) is a noted follow-up.
- **No DB test harness** in the repo (all 64 test files pure-unit) — the association/cascade/count DB writes are covered by pure-helper unit tests + this E2E, not DB-integration tests. The choke-point wiring was manually verified (project_id IS in the insert/patch) and E2E-confirmed.
- **FK `ON DELETE NO ACTION`** (consistent with sessions/memories) — hard-deleting a project with associated docs errors; Phase-3 merge repoints first.
