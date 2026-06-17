---
title: Project dashboard /projects/[slug] + editable slug (cascade rename)
cycle: 25-followup
date: 2026-06-16
status: shipped
branch: feat/project-dashboard
plans:
  - ../superpowers/plans/2026-06-16-project-dashboard.md
wiki:
  - ../wiki/projects.md
shipped:
  - "**Dashboard `app/pages/projects/[slug].vue`** (route keyed on **slug** — matches `getProject(slug)` + every `?project=<slug>` filter, zero extra lookups). Header (ProjectBadge + name/description + Edit + metadata: git remote, repo/prod/staging URL external links, aliases, local_paths, created/updated/last-active), a **stats row** (sessions · memories · tasks), and **`UTabs` Sessions | Tasks | Memories** reusing the existing filtered list hooks (`useSessionList`/`useTaskList`/`useMemoryList`) with loading/empty/error states; session rows deep-link to `/sessions/[id]` (tasks/memories have no per-item detail). 404/null → not-found state."
  - "**Route restructure:** `app/pages/projects.vue` → `app/pages/projects/index.vue` (list) beside `[slug].vue` (dashboard). **Row-click nav** on the list → `/projects/<slug>`; the active `USwitch` + pencil `@click.stop` so they don't navigate."
  - "**Editable slug + transactional cascade** (`updateProject`): `UpdateProjectInput.slug?`; on a slug change, in a `db.transaction` — uniqueness check (→ **409** mapped by the PATCH endpoint, shown as an inline modal field error), update the row, and **cascade `UPDATE sessions/tasks/memories SET project=<new> WHERE project=<old>`** (the denormalized slug columns; canonical `project_id` untouched). PATCH emits `publishChange` for project always + session/task/memory on a slug change. Slug zod `^[a-z0-9]+(?:-[a-z0-9]+)*$`. On `saved` with a changed slug the dashboard navigates to the new URL; on `delete` → `/projects`."
  - "**Reusable `<ProjectEditModal>`** (`app/components/ProjectEditModal.vue`, `v-model:open`/`:project`/`@saved`/`@deleted`) extracted from the list page (edit + delete + the new **Slug** field), used by both `/projects` and the dashboard; owns its own toasts. Removed the redundant list-row trash button (edit modal owns delete)."
  - "**Counts now key on the denormalized slug** (`COUNT_COLUMNS` shared by `listProjects`+`getProject`; added `taskCount` to `ProjectDTO`) — `where x.project = projects.slug`, NOT `project_id` — so header/list counts always match what the slug-filtered tabs show even when a row's slug and `project_id` have drifted. `getProject` now returns real counts (was 0)."
  - "**ProjectBadge now actually deep-links** (`app/components/ProjectBadge.vue`): default (absent `to`) → `/projects/<slug>`; `:to=\"null\"` → plain span. Fixed two latent bugs (see below). Memory card badges deep-link; session-detail badge deep-links."
  - "Gates green: typecheck 0 / test 336 / build. Playwright-validated end-to-end (dashboard render, tab switching, row-click nav, slug rename round-trip re-pointing 59 sessions + 4 memories, badge deep-link). Built subagent-driven (3 tasks, two-stage review each + final whole-branch review: READY TO MERGE)."
---

# Project dashboard + editable slug (cycle 25 follow-up)

Completes the two items deferred from cycle 25 (the [projects-ui-color handover](2026-06-16-projects-ui-color.md) "Where the next seam is"): the per-project dashboard and row-click navigation — plus a user-requested **editable slug** (which forced the rename-cascade). Built subagent-driven on `feat/project-dashboard`. Full behaviour: [wiki/projects.md](../wiki/projects.md).

## Two latent bugs caught in browser validation (not in the original plan)
Both were invisible to code review and only surfaced under `playwright-cli`:
1. **`<ProjectBadge>` never actually linked.** `<component :is="'NuxtLink'">` (a **string**) renders an inert `<nuxtlink>` custom element, not an `<a>` — so badges across the app (incl. the cycle-25 session-detail badge) were non-navigating. Fixed by resolving the real component object via `resolveComponent('NuxtLink')`.
2. **Boolean-prop casting.** `to?: string | false` made Vue treat `to` as a boolean prop, casting an **absent** `to` to `false` — indistinguishable from an explicit no-link, so every default-usage badge rendered as a span. Switched the contract to `to?: string | null` (`null` = no link; absent = dashboard) and converted the four `:to="false"` call sites to `:to="null"`.
3. (Also caught) **stats vs tabs mismatch** — counts were by `project_id` while tabs filter by slug; on drifted data the header said "0 sessions" next to a listed session. Now counts by slug (see wiki).

## Where the next seam is
This was the last of the projects **UI** follow-ups. The remaining projects work (the user's items 2 & 3) is functional, not cosmetic:
1. **Project association Phase 2** — call `findOrCreateProject` from the document/OCR/transcription/agent-tool write paths (today only session ingest + memory enrichment use it); auto-move project documents into `/Projects/<name>/**`. Then the dashboard can grow a **Documents tab** (deferred here — no doc↔project association exists yet). See the [project-association-foundation handover](2026-06-16-project-association-foundation.md) "next seam".
2. **Project merge (Phase 3)** — fold a legacy label project into its git-keyed twin (`gpx-workflows`→`gpx-workflows-2`, `my-mind`→`mymind`): repoint sessions/memories by `project_id`, archive/delete the loser. The editable-slug **cascade** here is a useful building block (renaming repoints the denormalized slug), but a true merge must repoint the canonical `project_id` and dedup, not just rename.

## Watch-outs
- **Slug rename re-points the denormalized slug, not the canonical id.** `updateProject`'s cascade updates `sessions/tasks/memories.project` (text); `project_id` is unchanged. That's correct for a rename (the project row keeps its uuid), but means a rename is NOT a merge — two distinct projects can't be unified by renaming one to the other's slug (the 409 blocks it anyway). Merge is Phase 3.
- **Counts are by slug now (deviation from cycle-25's `project_id` counts).** Intentional — keeps the dashboard internally consistent (stats == tabs) and robust to slug/`project_id` drift. The `/projects` list counts changed accordingly (e.g. a project that showed "0 sessions" now shows its real slug-based count). No index on the text `project` column, so counts are seq-scans — negligible at single-user scale (315 sessions / a few thousand memories); add a `project` index if it ever matters.
- **Memory/task rows are non-navigating** beyond a link to `/memories` / `/tasks` (no per-item detail pages exist — per the BACKLOG deep-link item). Session rows link to `/sessions/[id]`.
- **No migration** — the only schema touched this cycle was already shipped (cycle-25 `color` 0020); `taskCount` is computed, not stored. UI-only deploy.
