---
title: Project Merge (Phase 3) — fold a duplicate project into its canonical twin
cycle: 27
date: 2026-06-17
status: shipped
branch: feat/project-merge
spec: ../superpowers/specs/2026-06-17-project-merge-design.md
plans:
  - ../superpowers/plans/2026-06-17-project-merge.md
wiki:
  - ../wiki/projects.md
shipped:
  - "**`mergeProjects(loserSlug, winnerSlug)`** (`server/services/project-merge.ts`) — one `db.transaction`: guards (self / uncategorized / not-found → sentinel errors); capture `repointedMemoryIds`; repoint `sessions`/`memories` (by `project_id` OR `project=slug`) + `tasks` (slug-only) to the winner; **row-by-row** document repoint with path rewrite `/projects/L/`→`/projects/W/` + **collision uniquify** (`uniquifyPath` → `…-2.md`); absorb L's slug+aliases (+`gitRemoteKey` as an alias) + `local_paths` into W; **hard-delete L**. Returns `{ winner, repointedMemoryIds }`."
  - "**Post-merge memory dedup** (`dedupMemoriesAfterMerge`, `server/services/memory.ts`) — extracted `buildDedupCandidates` from `createMemory` (behavior-identical; `excludeId` dropped by drizzle `and()` for the create path), then sequentially collapses the repointed loser memories against the winner's bucket via `dedupDecision` (archive + evidence-merge). The deterministic near-neighbor/hash dedup; the LLM relationship-judge is a deferred enhancement."
  - "**`POST /api/projects/[slug]/merge`** `{ targetSlug }` → `mergeProjects` + dedup + emits (project deleted L / updated W + session/task/memory/document updated); maps guards to 400/404. `useProjects().merge(slug, targetSlug)`."
  - "**Dashboard `Merge` action** — `app/components/ProjectMergeModal.vue` (target `USelectMenu` excluding self+uncategorized, preview counts, destructive warning, `error` Merge button) wired into `/projects/[slug]` header → navigates to the winner on success."
  - "Pure helpers `uniquifyPath` / `mergeStringArrays` / `computeDocTargetPaths` unit-tested. Built subagent-driven (5 tasks, two-stage review each + final opus whole-branch review: **ship it**). Gates: typecheck 0 / test 393 / build."
  - "**Playwright E2E PASS** (full scenario): merged loser→winner — loser **404**, loser's docs/task/memory repointed, the colliding `dup.md` uniquified to `dup-2.md` (winner's own `dup.md` kept), winner absorbed `ztest-loser` as an alias, and the **near-duplicate memory collapsed** (2 → 1) by the post-merge dedup. Test data cleaned from the dev DB."
---

# Project Merge (Phase 3, cycle 27)

Item 3 of the projects roadmap — folds a legacy duplicate project into its git-keyed twin and deletes the dupe. Built subagent-driven on `feat/project-merge`. Full behaviour: [wiki/projects.md](../wiki/projects.md#project-merge-cycle-27--folding-a-duplicate-into-its-canonical-twin).

## Validation (playwright E2E, dev)
Created `ztest-winner` + `ztest-loser`; gave the loser 2 docs (one named `dup.md`), a task, a memory; gave the winner a colliding `dup.md` + a **near-duplicate** memory. Merged loser→winner: `mergeStatus 200`; loser **404** (hard-deleted); winner ended with 3 docs (`a.md`, `dup.md`, `dup-2.md` ← the uniquified collision), the task, and **1** memory (the near-dup pair **collapsed** by the dedup pass); winner `aliases: ['ztest-loser']`. The UI renders the `Merge` button + the destructive-warning modal. Test data removed from the dev DB afterward.

## Where the next seam is
The three projects roadmap items (dashboard, document association, merge) are all shipped. Natural follow-ups (none blocking):
- **Run the real merges in prod** via the new UI: fold `gpx-workflows`→`gpx-workflows-2`, `portfolio-v2`→`portfolio-v2-2`, `bridget`/`command-center`→`bridget-services`, `my-mind`→`mymind`. (Manual, user-driven — the dupes are real prod data.)
- **Model the three `project_id` FKs in the Drizzle schema** (`.references(() => projects.id)`) — see the watch-out. A backlog item.
- **Richer merge dedup** — layer the cycle-13 `judgeRelations` LLM supersede/contradict over the deterministic collapse (deferred).

## Watch-outs
- **Hard-delete is final** — no undo; the confirm dialog (counts + explicit delete warning) is the only guard.
- **Schema/DB FK divergence (latent trap):** `sessions`/`memories`/`documents`.`project_id` FK constraints exist in prod (raw SQL, migrations 0019/0021, `ON DELETE NO ACTION`) but are **not modeled** in the Drizzle schema — a future `pnpm db:generate` could emit a migration that DROPS them. Review any generated migration touching these FKs. (Same class as the existing partial-unique/GIN snapshot drift.)
- **Returned winner DTO is pre-dedup** — the endpoint returns the winner computed before the dedup pass archives duplicates, so its `memoryCount` can be transiently high; the dedup pass emits `memory` updates + the UI navigates (re-fetches), so it self-corrects. Cosmetic.
- **Cross-project doc-path scan:** `mergeProjects` pre-loads ALL live doc paths to detect collisions across projects — fine at homelab scale; scope it if the table grows large.
- **No DB test harness** (repo convention) — the transaction + dedup collapse are covered by the playwright E2E above + the unit-tested pure helpers; the choke logic was also reviewed against the schema.
