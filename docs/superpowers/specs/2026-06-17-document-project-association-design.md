---
title: Document ↔ Project Association (Phase 2)
date: 2026-06-17
status: design
cycle: 26
supersedes: null
related:
  - 2026-06-16-project-association-foundation-design.md
  - ../../handovers/2026-06-16-project-dashboard.md
---

# Document ↔ Project Association (Phase 2)

Phase 1 (cycle 23) made **canonical projects** keyed on the git remote and wired **sessions** + **agent memories** to resolve a `project_id`. The project-dashboard follow-up added the `/projects/[slug]` dashboard (Sessions/Tasks/Memories tabs) and an editable slug with a transactional rename-cascade. **Tasks are already associated** (create/edit task + their MCP tools accept a `project` slug; the kanban create/edit modals already have a project picker). This phase associates **documents** with projects and adds a **Documents** tab to the dashboard.

Documents are different from sessions: a document write path (manual create, quick-capture, the image-OCR spin-off, transcription) carries **no git remote or cwd** to resolve a project from. So association is **path-driven**, not creation-driven.

## Core invariant: path ⟺ project

> A document is associated with project *X* **if and only if** it lives under `/Projects/<X-slug>/…`.

The **path is the single source of truth** for filing. The row stores the resolved `project_id` (+ a synced `project` slug, denormalized for filtering) so queries don't re-parse paths, but those columns are always **derived from the path** on write — they never drift from it.

`/Projects` (capital P, a constant `PROJECTS_ROOT`) is the document-tree root for filed docs; it is unrelated to the app route `/projects`. Unfiled docs live in `/input/**` (the existing staging area) or elsewhere and have `project_id = null`.

## Data model

**Migration 0021** — `documents.project_id uuid references projects(id)` (nullable; index `documents_project_id_idx`). The existing `documents.project text` slug stays and is **kept in sync** with `project_id` (same denormalization as `sessions`/`memories`). Backfill: `UPDATE documents d SET project_id = p.id FROM projects p WHERE d.project = p.slug AND d.project_id IS NULL` (associates any docs whose slug is already set; the `/Projects/` convention is new so few/none exist yet).

`project_id` is the **durable identity** — it survives a slug rename and is what a future Phase-3 merge repoints. The `project` slug is cosmetic/denormalized (drives `?project=` filtering, consistent with the dashboard's other tabs).

## Resolver + the three triggers

**Pure helper** `projectFromPath(path): string | null` — returns `<seg>` from `^/Projects/([^/]+)/`, else null. (Unit-tested.)

**`matchProjectByLabel(label): Project | null`** (`server/services/projects.ts`) — matches an existing project by `slug = label` OR `aliases @> [label]` OR slugified `name = label`. **Match-only — never creates** (consistent with cycle-23's "creation is git-remote-only"). This is the same match logic as `findOrCreateProject`'s no-git branch, extracted so both share it. An unmatched folder ⇒ the doc keeps its path but `project_id` stays null (not auto-created).

**`setDocProjectFromPath(doc)`** — the association choke point. Given a doc's path: if `projectFromPath` returns a segment and `matchProjectByLabel` resolves it, set `project_id` + `project` slug; otherwise null both. Called by every path-mutating write.

The three triggers all funnel through the invariant:

1. **Manual move (the "move-listener")** — `moveDoc`/`updateDoc` (when `path` changes) and `createDoc` run `setDocProjectFromPath` after the path is set. Move **into** `/Projects/<x>/` ⇒ associate; move **out** ⇒ clear.
2. **Assign-project (reverse direction)** — a UI/enrichment "set project = X" action **moves** the doc to `/Projects/<X-slug>/<basename>` and associates it (assigning a project files the doc). Path-collision at the target reuses the existing path-uniqueness handling (suffix or error — match current `createDoc`/`moveDoc` behavior).
3. **`/input` enrichment classify** — the enrichment run that organizes `/input` has the LLM **classify the doc against the existing project list** (slug + name + description) and return a best-match project slug + confidence:
   - The project + target-path proposal **rides the existing enrichment review flow as one more field on the same `review_queue` proposal** as the frontmatter. Whatever gate the current flow uses (queue-for-human vs auto-review-threshold) governs it — the project proposal is **applied (move + associate) exactly when its review item is approved** (auto-approved at high confidence if the existing threshold mechanism does so; otherwise on manual approval).
   - **no match ⇒** leave in `/input`, unassigned (no proposal).
   - The implementer first confirms the current enrichment auto-apply-vs-queue behavior (the Explore found `runEnrichInput` queues a `review_queue` row and never mutates the doc directly) and extends THAT path — no new auto-apply mechanism is built here.

## Slug-rename cascade (extends the dashboard's editable slug)

`updateProject` already cascades a slug rename to `sessions/tasks/memories.project`. This phase **extends that same transaction** to documents: for every doc with `project_id = <id>`, rewrite the `project` slug to the new slug **and** the path prefix `^/Projects/<old>/` → `/Projects/<new>/` (so filed docs move with the rename). `project_id` is unchanged. Path-prefix rewrite preserves relative subpaths, so no new collisions within the project's own subtree. Emits a `document` `publishChange` so the tree refreshes.

## Surfacing

- **`?project=<slug>` filter** on the documents list/search: `listTree(opts?: { project? })` and `searchDocs(q, opts?: { project? })` + their endpoints (`tree.get`, `search.get`) gain a `project` query param (filter by the denormalized `project` slug, matching the dashboard's other tabs).
- **`documentCount`** added to `ProjectDTO` + the shared `COUNT_COLUMNS` (count by `documents.project = projects.slug`, consistent with item 1's slug-based counts). The dashboard stats row gains a Documents count.
- **Documents tab** on `/projects/[slug]` — a fourth tab beside Sessions/Tasks/Memories, listing the project's docs (`useDocuments`/a documents list hook filtered by slug), each row linking to the document editor (`/documents?...` deep-link as supported, else the documents page).

## In-passing fix

The image-OCR → document spin-off (`server/services/image-enrich.ts`) creates a document via `createDoc` but does **not** emit `publishChange({ resource: 'document', … })` (the only doc write path missing it). Add the emit so OCR-spawned docs appear live in the tree.

## Edge cases & decisions

- **Unmatched `/Projects/<x>/` folder** → unassigned (match-only). Documented; avoids spawning junk projects from stray folders.
- **Move out of `/Projects/`** → `project_id` cleared (path is the source of truth).
- **Manual API `project` field** — the manual create/update endpoints currently accept a `project` slug directly. Decision: setting `project` via the API is treated as an **assign-project** (trigger 2) — the service files the doc under `/Projects/<slug>/` and resolves `project_id` so the invariant holds (rather than letting `project` drift from the path). The field stays in the API surface; its effect is now "file + associate."
- **Path collisions** on assign/auto-file reuse existing path-uniqueness behavior; the slug-rename subtree move preserves relative paths (no intra-project collision).
- **`uncategorized`** project is not a filing target (`/Projects/uncategorized/` would resolve to it via match, which is acceptable but not auto-created by enrichment).

## Out of scope

- **Tasks** — already associated (slug + UI picker + MCP args); no path/move model applies (tasks have no files).
- **Project merge (Phase 3)** — folding a legacy label project into its git-keyed twin (repoint `project_id`, archive loser).
- **Per-write-path `findOrCreateProject` from git/cwd** — OCR/capture/transcription carry no such signal; they file into `/input` and associate at filing/enrichment time (this is the deliberate refinement of the original "call findOrCreateProject from every write path" framing).

## Testing

- Pure helpers unit-tested: `projectFromPath` (matches `/Projects/x/…`, rejects `/input/…`, `/Projectsfoo`, root), `matchProjectByLabel` (slug/alias/name match, no-match → null, never creates).
- Service-level: move into/out of `/Projects/<x>/` sets/clears association; assign-project moves the file; slug rename rewrites doc paths + slug, leaves `project_id`.
- Playwright E2E: file a doc under a project (move) → it appears in the dashboard Documents tab + the count increments; rename the project slug → the doc's path follows; `?project=` filter on the docs page.
- Gates: typecheck 0 / test green / build, per the project's real gates.
