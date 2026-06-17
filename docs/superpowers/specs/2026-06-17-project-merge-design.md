---
title: Project Merge (Phase 3)
date: 2026-06-17
status: design
cycle: 27
related:
  - 2026-06-16-project-association-foundation-design.md
  - 2026-06-17-document-project-association-design.md
  - ../../handovers/2026-06-16-project-dashboard.md
---

# Project Merge (Phase 3)

Phase 1 (cycle 23) keyed projects on the git remote; the bulk history import grouped sessions by the bridget **label** (cwd basename) when no git remote was recorded (only 63/457 had one). The result: **legacy label projects coexist with their git-keyed twins** — confirmed dupes in prod: `gpx-workflows` (label) ↔ `gpx-workflows-2` (git), `portfolio-v2` ↔ `portfolio-v2-2`, `bridget`/`command-center` ↔ `bridget-services`, `my-mind` ↔ `mymind`. This phase adds a **merge** flow to fold the loser into the winner and delete the dupe.

Item-1's editable-slug rename keeps the *same* project row (just renames it). A merge is different: it **repoints `project_id`** from one row to another, then removes the loser row.

## What a merge repoints (loser L → winner W)

All references to L move to W, matched by the **canonical `project_id` OR the denormalized `project = L.slug`** (catch any drift between the two):

| Table | Repoint | Key |
|---|---|---|
| `sessions` | `project_id = W.id`, `project = W.slug` | `project_id = L.id OR project = L.slug` |
| `memories` | `project_id = W.id`, `project = W.slug` | `project_id = L.id OR project = L.slug` |
| `documents` | `project_id = W.id`, `project = W.slug`, **+ path rewrite** (below) | `project_id = L.id OR project = L.slug` |
| `tasks` | `project = W.slug` | `project = L.slug` (tasks have no `project_id`) |

**Document path rewrite + collision handling.** Each loser doc filed under `/projects/L.slug/<rest>` moves to `/projects/W.slug/<rest>` (reuse `rewriteProjectPathPrefix` from cycle 26). Unlike the slug-rename (one self-consistent subtree), a merge brings **two** doc trees together, so `/projects/W.slug/<rest>` may already exist. So the doc repoint is **row-by-row**: compute the target path; if it collides with a live doc path (the `documents_path_live_uidx`), append a uniquifier (`<name>-2.md`, `-3`, … — mirror `nextUniqueSlug`'s strategy). Docs NOT under `/projects/L.slug/` (e.g. loser docs in `/input/` that carry `project = L.slug`) just get `project_id`/`project` repointed, no path change.

## `mergeProjects(loserSlug, winnerSlug)` — transactional core

In one `db.transaction`:
1. Load L and W (both must exist; else throw). Guards: reject if `L.id === W.id` (no self-merge); reject if **either** L or W is the seeded `uncategorized` project (don't delete the fallback bucket as a loser, don't fold real work into it as a winner).
2. Repoint sessions/memories/tasks (bulk `UPDATE`s on `tx`). Repoint documents row-by-row with path-collision handling.
3. **Absorb L's identity into W** (so future ingests that matched L resolve to W): `W.aliases = dedupe([...W.aliases, L.slug, ...L.aliases])`; if `W.git_remote_key` is null and `L.git_remote_key` is set, also push `L.git_remote_key` into `W.aliases` (don't move the key itself — `git_remote_key` is partial-unique and W keeping its own is correct; the alias makes `findOrCreateProject`'s `aliases @>` branch match). Merge `W.local_paths = dedupe([...W.local_paths, ...L.local_paths])`. Bump `W.last_activity_at = greatest(W, L)`.
4. **Hard-delete L** (`DELETE FROM projects WHERE id = L.id`). All FK refs are repointed, so the `ON DELETE NO ACTION` FK is satisfied.
5. Return W (refreshed DTO with counts).

Emit (after commit): `publishChange` for `project` (W + the deleted L's slug) and `session`/`task`/`memory`/`document` so every list refreshes cross-tab.

## Post-merge memory dedup

After the merge transaction commits, run a dedup pass over W's memory bucket to collapse the duplicates the merge created (the same fact may have been enriched into both L and W). **Reuse the existing machinery** — do NOT build new dedup logic:
- For each memory **repointed from L** (the candidates that just entered W's `(scope, project)` partition), run the same near-neighbor search + `dedupDecision` (`server/services/memory-dedup.ts`) that `createMemory` uses, against W's bucket, and apply the resolution via the existing resolve path (`server/services/memory-resolve.ts` / the `judgeRelations` LLM judge in `server/lib/ai/memory-judge.ts`): an exact/near-duplicate is archived (or a `supersede`/`contradict` `memory_relations` row + review item is created, exactly as enrichment does today).
- The plan extracts the "apply a dedup decision to an existing memory" step from `createMemory` into a reusable function so the merge pass and `createMemory` share it (DRY) — rather than duplicating the resolution logic.
- This pass is **iterative + may call the LLM**, so it runs **after** the transaction (not inside it). It's a one-time admin action, so per-memory LLM cost is acceptable. If a project has many memories, it may take a while — acceptable for an admin merge.
- Emit `memory` changes as it archives/relates.

## Endpoint

`POST /api/projects/[slug]/merge` body `{ targetSlug: string }` (the `[slug]` is the **loser**; `targetSlug` is the **winner**). Validates with zod; calls `mergeProjects(slug, targetSlug)` then the dedup pass; maps guard violations (self-merge, uncategorized, missing) to `400`/`404`. Returns the winner DTO.

## UI — dashboard "Merge into…"

On `/projects/[slug]` (the loser's dashboard): a **"Merge into…"** action (in the header overflow or the Edit modal — secondary, not primary). Opens a confirm dialog:
- A target-project `USelectMenu` (all active projects except this one and `uncategorized`).
- A **preview of what moves**: "N sessions · M memories · K docs · J tasks will move to **{winner}**" (from the loser's `ProjectDTO` counts — already available: `sessionCount`/`memoryCount`/`documentCount`/`taskCount`).
- A clear destructive warning: "**{loser}** will be deleted. This cannot be undone."
- On confirm: `POST …/merge`, toast success, `navigateTo('/projects/' + targetSlug)`.

## Edge cases & decisions
- **Self-merge / uncategorized** → rejected (guards above).
- **Doc path collisions** → uniquify the loser doc's target path (row-by-row repoint).
- **Slug freed** — after hard-delete, L's slug is available again; it's preserved as a W alias so re-ingest resolves to W (not a fresh project).
- **No undo** — hard-delete is final; the confirm dialog (with counts + the explicit delete warning) is the guard. (Acceptable per the decision to hard-delete.)
- **Tasks repoint by slug only** (no `project_id`) — `UPDATE tasks SET project = W.slug WHERE project = L.slug`.

## Out of scope
- Auto-detecting/suggesting merge candidates (the user picks loser + winner).
- Merge undo / soft-merge.
- Bulk/multi-merge in one action.

## Testing
- Pure helpers unit-tested: the doc-path uniquifier (collision → `-2`/`-3`), the alias/local_paths dedupe-merge.
- The repoint set + hard-delete + dedup-apply reuse is validated by the controller's **playwright E2E** (repo has no DB harness): create two projects with overlapping data, merge, assert sessions/memories/docs/tasks moved to the winner, the loser 404s, W absorbed L's slug as an alias, a duplicate memory collapsed, and a colliding doc path got uniquified.
- Gates: typecheck 0 / test green / build.
