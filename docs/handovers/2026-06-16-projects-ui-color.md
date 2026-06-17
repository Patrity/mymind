---
title: Projects UI + per-project color (ProjectBadge everywhere)
cycle: 25
date: 2026-06-16
status: shipped
branch: feat/projects-ui-color
plans:
  - ../superpowers/plans/2026-06-16-projects-ui-color.md
wiki:
  - ../wiki/projects.md
shipped:
  - "**`color` column** (migration 0020, nullable) + `app/utils/project-color.ts`: `PROJECT_PALETTE` (14 hues) + `NEUTRAL_COLOR` grey. `projectColor(slug, override) = override || NEUTRAL_COLOR` — **grey is the default for every project until the user picks a colour** (the 14 hues are opt-in)."
  - "**`<ProjectBadge :slug :name? :color? :to?>`** (`app/components/ProjectBadge.vue`): a coloured pill. Resolves colour from an explicit prop → the shared **`useProjectColors()`** map (one cached projects query → slug→override) → the grey default. So a custom colour set on `/projects` shows on EVERY surface with no per-DTO plumbing. Used on memories cards, session detail, and task cards (each replaced a plain badge)."
  - "**`ProjectDTO` expanded** (`shared/types/tasks.ts` + `toDTO`) to the full model: `id`, `color`, `git_remote_key`, repo/prod/staging URLs, `aliases`, `local_paths`, `last_activity_at`, + **`sessionCount`/`memoryCount`** (count subqueries in `listProjects`, ordered by last-activity). `updateProject` + the PATCH zod + the `useProjects().update` body all accept the new editable fields."
  - "**`/projects` page reworked** (`app/pages/projects.vue`): each row shows the coloured `<ProjectBadge>`, git remote, `N sessions · M memories`, last-active. The Edit modal gained repo/prod/staging URL inputs, an **aliases** `UInputTags`, a **colour swatch picker** (a leading grey 'Default' swatch = `color:null`, then the 14 hues) with a live badge preview, and read-only `git_remote_key`/`local_paths`. New-project modal unchanged (new projects start grey)."
  - "**`findOrCreateProject` now matches by alias/label** (`server/services/projects.ts`): the no-git-remote branch derives the cwd basename, slugifies it, and matches an existing project on `slug = lslug OR aliases @> [label] OR aliases @> [lslug]` before falling back to Uncategorized — so a non-git `…/bridget-services` session resolves to the friendly-named 'Bridget Services' project (alias `bridget-services`). No auto-create from a bare label (creation stays git-remote-only)."
  - "Pure `projectColor` unit-tested; UI playwright-validated (colour change persists + badge recolours). Gates green (typecheck 0 / test 326 / build). Built subagent-driven on `feat/projects-ui-color`."
---

# Projects UI + per-project color (Cycle 25)

The `/projects` page went from a slug/name/description/active stub to a full surface of the cycle-23 project model, every project got a colour (grey by default, overridable), and a reusable `<ProjectBadge>` now colours project references across memories/sessions/tasks. Full behaviour: [wiki/projects.md](../wiki/projects.md).

## Where the next seam is (DEFERRED — designed, not built)
The user asked for these mid-cycle; deferred to a fresh session (this one ran long):
1. **Project dashboard `/projects/[slug]`** (clicking a project row navigates there). Design agreed: a **header** (ProjectBadge + name/description + Edit + metadata: git remote, repo/prod/staging URL links, aliases, local_paths, dates) + a **stats row** (sessions·memories·tasks) + **tabbed sections Sessions | Tasks | Memories**, each reusing the existing `?project=` filtered endpoints with rows linking to their detail. Key the route on **slug** (matches the existing `getProject(slug)` API; the user said "uuid" — confirm slug-vs-uuid). Documents deferred (no project association yet).
2. **Row-click → dashboard** on `/projects` (trivial once the page exists).

## Watch-outs
- **Colour default is grey now** — projects are visually uniform until the user colours them on `/projects`. Custom colours propagate everywhere via `useProjectColors` (a shared cached query — many `<ProjectBadge>` instances dedupe to one fetch).
- **`findOrCreateProject` label-matching is MATCH-only** — it won't create a project from a bare cwd label, so a non-git session whose basename matches nothing still lands in Uncategorized (correct — avoids spawning junk projects from random dirs).
- **Project merge (phase-3) still pending** — legacy label projects (e.g. `gpx-workflows`) vs git-keyed (`gpx-workflows-2`) still coexist; the dashboard + merge are the natural next projects work.
