---
title: Project Dashboard `/projects/[slug]` + editable slug
cycle: 25-followup
date: 2026-06-16
branch: feat/project-dashboard
status: in-progress
---

# Project Dashboard + editable slug

Deferred work from cycle 25 (see `docs/handovers/2026-06-16-projects-ui-color.md` "Where the next seam is"). Build a per-project dashboard at `/projects/[slug]`, make project rows on `/projects` navigate there, and (new user ask) make the project **slug editable** — which requires cascading the rename to the denormalized `project` slug columns on sessions/tasks/memories.

## Context (current state — verified)

- `/projects` is `app/pages/projects.vue` (list + New/Edit/Delete modals inline). It already surfaces the full cycle-23 model (git remote, URLs, aliases, local_paths, session/memory counts) and a color picker. The Edit modal is ~150 lines inline.
- Routing decision: **slug** (user-confirmed). All filtered list endpoints key off the denormalized `project` *slug string*:
  - `GET /api/sessions?project=<slug>` → `eq(sessions.project, slug)`
  - `GET /api/tasks?project=<slug>` → `eq(tasks.project, slug)`
  - `GET /api/memories?project=<slug>` → `eq(memories.project, slug)`
  - `GET /api/projects/[slug]` → `getProject(slug)` (header data)
- Composables (all live via @tanstack/vue-query): `useProjects()` (`useProjectList`, `useProjectColors`, `create/update/remove`), `useSessions().useSessionList({project})`, `useTasks().useTaskList(slug)`, `useMemories().useMemoryList({project})`.
- `ProjectDTO` (`shared/types/tasks.ts`) has `sessionCount`/`memoryCount` but **no `taskCount`**. `getProject` returns counts of 0 (no count subqueries); only `listProjects` computes counts.
- `<ProjectBadge :slug :name? :color? :to?>` (`app/components/ProjectBadge.vue`) renders a colored pill; `to` defaults to the static string `'/projects'`, `to={false}` renders a plain `<span>`.
- Denormalized project columns: `sessions.project` (text) + `sessions.projectId` (uuid); `tasks.project` (text, **no projectId**); `memories.project` (text) + `memories.projectId` (uuid). On a slug rename only the **text slug** columns move; `projectId` is unchanged.
- Live: `dispatchLiveEvent` invalidates `[resource, id]` + `[resource, 'list']` for every event. `ResourceName` includes `project | session | task | memory`. `publishChange({resource, action, id})` from `server/utils/live-bus.ts`.
- 409 pattern: services throw `Error('...already exists')`; `index.post.ts` maps `msg.includes('already exists')` → `createError({ statusCode: 409 })`. Mirror this for slug-edit conflicts.
- DB: `useDb()` (drizzle/node-postgres) supports `db.transaction(async (tx) => …)`. No existing usage; introduce it for the atomic rename.
- Detail pages that exist: `/sessions/[id]` (real detail). **Tasks and memories have NO per-item detail page** (kanban board `/tasks`, list `/memories`). So task/memory rows link to their home page; only session rows deep-link to a detail.

## Global Constraints (bind every task)

- **Nuxt UI v4 components only** (`U*`), semantic color tokens only (`text-muted`, `bg-elevated`, `primary`/`error`/`neutral`, …) — never raw Tailwind palette classes. Invoke the `nuxt-ui-docs` skill before using/altering a component. (`.claude/rules/web-vue-ui.md`)
- **Live-data convention** (`.claude/rules/live-data.md`): reads via @tanstack/vue-query (keys `[resource, id]` / `[resource, 'list', params]`, reactive params wrapped in `computed`, `data` read-only); every server mutation calls `publishChange` after commit. A slug rename mutates sessions/tasks/memories too — emit one `publishChange` per affected resource so their lists refresh cross-tab.
- **Secrets via `runtimeConfig`**, app code under `apps/web/app/`, Nitro under `apps/web/server/` (this repo root *is* the web app — paths above are relative to repo root).
- Gates: `pnpm typecheck` (0 errors) + `pnpm test` (currently 326 passing — keep green, add tests for new pure logic) + `pnpm build`. Lint is red repo-wide; not a gate.
- Keep `master`-merge discipline: this is on `feat/project-dashboard`.

## Task 1 — Backend: editable slug (cascade rename) + dashboard counts

**Files:** `server/services/projects.ts`, `server/api/projects/[slug].patch.ts`, `app/composables/useProjects.ts`, `shared/types/tasks.ts`, plus a unit test.

1. **`ProjectDTO` + counts.** Add `taskCount: number` to `ProjectDTO` (`shared/types/tasks.ts`). In `server/services/projects.ts`:
   - Extend `toDTO(r, counts?)` to include `taskCount: counts?.taskCount ?? 0`.
   - `listProjects`: add a `taskCount` subquery `(select count(*)::int from tasks t where t.project = projects.slug)` alongside the existing session/memory subqueries; pass it through.
   - `getProject(slug)`: change from a bare select to the same count-subquery select used by `listProjects` (so the dashboard header gets real `sessionCount`/`memoryCount`/`taskCount` from one fetch). Keep the return type `ProjectDTO | null`.
   - Note: sessions/memories count by `project_id` (uuid) as `listProjects` already does; tasks count by the `project` slug string (tasks has no `project_id`). Match each table's actual FK.

2. **Editable slug + cascade.** Extend `UpdateProjectInput` with `slug?: string`. In `updateProject(slug, patch)`:
   - If `patch.slug` is provided and **differs** from the current `slug`:
     - Normalize/validate: treat the incoming value as the desired slug; reject empty. (The endpoint zod slugifies/validates shape — see below — so the service can trust a non-empty slug string, but still guard against empty.)
     - **Uniqueness:** if another project already has `patch.slug`, throw `new Error('Project slug "<slug>" already exists')` (so the handler maps to 409). Check via a select `WHERE slug = patch.slug` (any hit is a different project, since the current row still holds the old slug).
     - Run the update **in a `db.transaction`**: update the `projects` row (slug + other patch fields + `updatedAt`), then cascade `UPDATE sessions SET project = newSlug WHERE project = oldSlug`, `UPDATE tasks SET project = newSlug WHERE project = oldSlug`, `UPDATE memories SET project = newSlug WHERE project = oldSlug`. (`projectId` untouched.)
     - Return the updated DTO (counts via the same subqueries, or re-`getProject(newSlug)`).
   - If `patch.slug` is absent or unchanged: behave exactly as today (single update by slug), still returning a DTO.
   - Keep all existing patch fields working (name/description/active/color/urls/aliases).

3. **PATCH endpoint** (`server/api/projects/[slug].patch.ts`):
   - Add `slug` to the zod `Body`: `slug: z.string().trim().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug').optional()`. (Lowercase, hyphen-separated — matches `slugify` output. Reject `uncategorized`? No — allow; renaming away from it is fine, renaming *to* a taken slug is the 409.)
   - Wrap the `updateProject` call to map a slug-conflict Error (`msg.includes('already exists')`) → `throw createError({ statusCode: 409, statusMessage: 'Project slug already exists' })`, mirroring `index.post.ts`.
   - Emit live changes: always `publishChange({ resource: 'project', action: 'updated', id: project.slug })`. **When the slug changed** (body.slug present and `!== slug` param), additionally emit `publishChange` for `session`, `task`, and `memory` (action `updated`, id = new slug) so their lists refetch cross-tab.

4. **Composable type** (`app/composables/useProjects.ts`): add `slug?: string` to the `update` body parameter type. Add a singular detail hook `useProject(slug: MaybeRefOrGetter<string | undefined>)` returning `useQuery({ queryKey: ['project', slugRef], queryFn: () => ofetch('/api/projects/'+slug) })` (enabled when slug present) for the dashboard — keyed `['project', slug]` so the existing `{resource:'project'}` emit invalidates it.

**Tests:** unit-test the slug-cascade decision is out of reach for a pure fn, but add/extend a test that exercises the new `taskCount` in `toDTO` if a pure mapper test exists; otherwise add a small test asserting the zod slug regex accepts `my-project`/`mymind` and rejects `My Project`/empty/`a--b` trailing. Keep `pnpm test` green.

**Out of scope:** auto-adding the old slug as an alias (deferred); changing how `findOrCreateProject` matches.

## Task 2 — Reusable `<ProjectEditModal>` component (with slug field)

**Files:** new `app/components/ProjectEditModal.vue`; edit `app/pages/projects.vue` (will become `projects/index.vue` in Task 3 — for this task edit it in place as `app/pages/projects.vue`) to consume the component.

Extract the **Edit + Delete** flow currently inline in `projects.vue` into a reusable component so both the list page and the new dashboard can open it.

- **Component API:** `app/components/ProjectEditModal.vue`
  - Props: `project: ProjectDTO | null`, `open: boolean` (use `defineModel<boolean>('open')`).
  - Emits: `saved` (payload: the updated `ProjectDTO` returned by the PATCH) and `deleted` (payload: the slug that was deleted).
  - Contains the full edit form moved verbatim from `projects.vue`: name, description, active switch, **slug** (new field), repository/production/staging URL inputs, aliases `UInputTags`, color swatch picker (grey "Default" = `null` + `PROJECT_PALETTE`) with the live `<ProjectBadge>` preview, and the read-only `git_remote_key`/`local_paths` block. Plus the inline Delete button → delete-confirm modal (moved verbatim).
  - **Slug field:** a `UFormField label="Slug"` with `UInput` bound to `editForm.slug`, seeded from `project.slug` on open. Hint: "Changing the slug updates its URL and re-points its sessions, tasks, and memories." On save, include `slug` in the PATCH body **only if it changed** (avoid a needless cascade). On a **409** response, set an inline `slugError` on the field ("A project with this slug already exists.") and keep the modal open — mirror the New-project-modal 409 handling already in `projects.vue`.
  - On successful save: emit `saved(updated)` and close. On successful delete: emit `deleted(slug)` and close.
  - Uses `useProjects().update/remove`, `useToast()` for success/error toasts (same toasts as today).
- **`projects.vue` consumes it:** replace the inline Edit + Delete modals with `<ProjectEditModal v-model:open="showEditModal" :project="editingProject" @saved="onSaved" @deleted="onDeleted" />`. `openEditModal(project)` just sets `editingProject` + `showEditModal`. `onSaved`/`onDeleted` refetch the list (or rely on live invalidation) + toast. The New-project modal stays inline in `projects.vue` (not part of this component).

**Constraint:** behavior parity with today's edit/delete (same fields, same validation, same toasts) **plus** the slug field. Nuxt UI v4 + semantic tokens. Validate the extraction didn't regress the page (typecheck + a quick render).

## Task 3 — Dashboard page + route restructure + nav + badge link

**Files:** rename `app/pages/projects.vue` → `app/pages/projects/index.vue`; new `app/pages/projects/[slug].vue`; edit `app/components/ProjectBadge.vue`.

1. **Route restructure.** Move `app/pages/projects.vue` to `app/pages/projects/index.vue` (Nuxt nested route: `/projects` → `index.vue`, `/projects/:slug` → `[slug].vue`). No content change beyond Task 2's consumption of `<ProjectEditModal>`. Keep `definePageMeta({ title: 'Projects' })`.

2. **Row-click navigation** on the list (`projects/index.vue`): clicking a project row navigates to `/projects/${project.slug}`. Guard the interactive controls — the active `USwitch` and the Edit/Delete action buttons must `@click.stop` (or stop propagation) so they don't trigger navigation. Implement by wrapping the row content in a click handler `navigateTo('/projects/' + project.slug)` with the controls stopping propagation, or make the name/body area a `NuxtLink`. Cursor-pointer + hover affordance.

3. **Dashboard page** `app/pages/projects/[slug].vue`:
   - `const slug = computed(() => route.params.slug as string)`. `definePageMeta({ title: 'Project' })`.
   - **Data:** `const { data: project, isPending, error } = useProjects().useProject(slug)`. On 404 (error), render a not-found state ("Project not found" + back link to `/projects`).
   - **Layout:** `UDashboardPanel` with a `#header` `UDashboardNavbar` (title = project name, `#leading` a back button to `/projects` + `UDashboardSidebarCollapse`, `#right` an **Edit** `UButton` opening `<ProjectEditModal>`).
   - **Header block (#body top):** large `<ProjectBadge :slug :name :color :to=false />`, description, and a metadata grid: git remote (`gitRemoteKey`, mono, with git-branch icon), repository/production/staging URLs as external links (`UButton variant=link` / anchor with `target=_blank rel=noopener`, only when set), aliases as small badges, `localPaths` (mono, comma-joined), and dates (created / updated / last-active — reuse a `formatDate`).
   - **Stats row:** three stat cells — Sessions (`project.sessionCount`) · Memories (`project.memoryCount`) · Tasks (`project.taskCount`). Use `UPageCard`/simple bordered cells; click a stat optionally activates the matching tab (nice-to-have, not required).
   - **Tabs** (`UTabs` — drive with real clicks per the reka-tabs rule when testing): **Sessions | Tasks | Memories**.
     - Sessions tab: `useSessions().useSessionList(() => ({ project: slug.value }))`; rows show source/title/started/lastActive/message+token counts (mirror `/sessions` list row style) and navigate to `/sessions/${id}`.
     - Tasks tab: `useTasks().useTaskList(slug)`; rows show title, status badge, priority, due date. No per-task detail page → row links to `/tasks` (or is non-navigating). Note the deferral in a comment.
     - Memories tab: `useMemories().useMemoryList(() => ({ project: slug.value }))`; rows show content (truncated), scope badge, `sourceDate ?? createdAt`. No per-memory detail → non-navigating or link to `/memories`.
     - Each tab: loading skeletons, empty state ("No sessions yet for this project."), error via the query's `error` ref.
   - **Edit integration:** `<ProjectEditModal v-model:open="showEdit" :project="project" @saved="onSaved" @deleted="onDeleted" />`. `onSaved(updated)`: if `updated.slug !== slug.value`, `navigateTo('/projects/' + updated.slug, { replace: true })` (the rename moved the URL); else rely on live `['project', slug]` invalidation. `onDeleted()`: `navigateTo('/projects')`.

4. **ProjectBadge default link** (`app/components/ProjectBadge.vue`): change the default so a badge with no `to` prop links to the project's dashboard. Replace `withDefaults(..., { to: '/projects' })` so `to` is optional (no static default), and compute the href: `to === false ? undefined : (props.to ?? '/projects/' + encodeURIComponent(props.slug))`. Existing `:to="false"` usages keep rendering a span; existing default usages (memories/sessions/tasks cards) now deep-link to the dashboard — the intended "clicking a project reference navigates there."

**Validation:** `pnpm typecheck` + `pnpm build`; playwright-cli (register `test@example.com`/`testpassword123` if needed): load `/projects`, click a row → dashboard renders header+stats+tabs; switch tabs (real clicks); edit the slug → URL updates and tabs still populate; a project badge on `/memories` links to the dashboard.

## Out of scope (explicitly deferred)
- Document tab / document↔project association (no association exists yet — that's the separate Phase-2 work).
- Per-task / per-memory detail pages or deep-links.
- Project merge (phase-3).
- Auto-aliasing the old slug on rename.
