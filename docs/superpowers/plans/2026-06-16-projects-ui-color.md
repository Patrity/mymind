# Projects UI + per-project color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Surface the full cycle-23 project model on `/projects`, add a per-project `color`, and a reusable colored `<ProjectBadge>` used everywhere a project is referenced.

**Architecture:** `color text` nullable column (null = deterministic default). A pure `projectColor(slug, override?)` picks a stable hex from a ~14-color palette (override wins, else slug-hash → palette). `<ProjectBadge>` renders a colored pill via inline `:style` (UBadge's `color` prop only takes theme aliases). The DTO/service expand to expose all fields + session/memory counts.

**Tech Stack:** Nuxt 4 / Nuxt UI v4, Drizzle/Postgres, Vitest, @tanstack/vue-query.

**Design (approved):** color = auto-palette + override; badge = custom colored pill; wire into surfaces that already show a project (memories, sessions, tasks) — no new project plumbing on surfaces that don't. Out of scope: project **merge** (phase-3), the `details` KV editor.

**Conventions:** `pnpm`; gates `pnpm typecheck` (0)/`pnpm test`/`pnpm build`; lint NOT a gate. `node_modules/.bin/vitest run test/<f>`. Validate UI with **playwright-cli**; dev login `test@example.com`/`testpassword123` (register first user if dev DB fresh).

---

## File Structure
- **Create:** `app/utils/project-color.ts` (pure palette + `projectColor`); `test/project-color.test.ts`; `app/components/ProjectBadge.vue`.
- **Modify:** `server/db/schema/projects.ts` (+`color`); `server/db/migrations/0020_*.sql`; `shared/types/tasks.ts` (`ProjectDTO`); `server/services/projects.ts` (`toDTO`, `listProjects`+counts, `getProject`+counts, `UpdateProjectInput`, `updateProject`); `server/api/projects/[slug].patch.ts` (zod body); `app/composables/useProjects.ts` (update/create body); `app/pages/projects.vue` (surface fields + color picker + counts); `app/pages/memories.vue` + `app/pages/sessions/[id].vue` + `app/pages/tasks.vue` (use `<ProjectBadge>`); `docs/wiki/projects.md`.

---

## Task 1: Pure project-color helper (TDD)
**Files:** Create `app/utils/project-color.ts`, `test/project-color.test.ts`.

- [ ] **Step 1 — failing test:**
```ts
import { describe, it, expect } from 'vitest'
import { projectColor, PROJECT_PALETTE } from '../app/utils/project-color'

describe('projectColor', () => {
  it('override wins', () => { expect(projectColor('anything', '#123456')).toBe('#123456') })
  it('is deterministic per slug and a palette member', () => {
    const a = projectColor('mymind'); const b = projectColor('mymind')
    expect(a).toBe(b)
    expect(PROJECT_PALETTE).toContain(a)
  })
  it('distributes (two different slugs need not collide)', () => {
    expect(projectColor('mymind')).not.toBe(projectColor('2d-rpg'))
  })
  it('ignores empty override', () => { expect(PROJECT_PALETTE).toContain(projectColor('x', null)) })
})
```
- [ ] **Step 2 — run, expect FAIL.** `node_modules/.bin/vitest run test/project-color.test.ts`
- [ ] **Step 3 — implement** `app/utils/project-color.ts`:
```ts
// 14 distinct hues (Tailwind 500s) that read on the dark theme.
export const PROJECT_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'
] as const

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0
  return h
}

/** Stable per-project hex: the override if set, else a palette colour derived from the slug. Pure. */
export function projectColor(slug: string, override?: string | null): string {
  if (override) return override
  return PROJECT_PALETTE[hash(slug) % PROJECT_PALETTE.length]!
}
```
- [ ] **Step 4 — run, expect PASS;** `pnpm typecheck`.
- [ ] **Step 5 — commit:** `git add app/utils/project-color.ts test/project-color.test.ts && git commit -m "feat(projects): pure project-color palette helper"`

---

## Task 2: Schema + DTO + service + endpoint + composable
**Files:** as listed.

- [ ] **Step 1 — schema** (`server/db/schema/projects.ts`): add a column after `details` (or near the other text cols):
```ts
  color: text('color'),
```
- [ ] **Step 2 — migration:** `pnpm db:generate` → a `0020_*.sql` with `ALTER TABLE "projects" ADD COLUMN "color" text;` (simple add — no hand-editing needed). Then `pnpm db:migrate`. Verify: `psql "$DATABASE_URL" -c '\d projects' | grep color`.
- [ ] **Step 3 — DTO** (`shared/types/tasks.ts`): expand `ProjectDTO` to:
```ts
export interface ProjectDTO {
  id: string
  slug: string
  name: string
  description: string
  active: boolean
  color: string | null
  gitRemoteKey: string | null
  repositoryUrl: string | null
  productionUrl: string | null
  stagingUrl: string | null
  aliases: string[]
  localPaths: string[]
  lastActivityAt: string | null
  sessionCount: number
  memoryCount: number
  createdAt: string
  updatedAt: string
}
```
- [ ] **Step 4 — service** (`server/services/projects.ts`): import `sessions`, `memories`, `sql` (from `drizzle-orm`) and the schema tables. Update `toDTO` to accept optional counts and map the new fields:
```ts
function toDTO(r: typeof projects.$inferSelect, counts?: { sessionCount: number, memoryCount: number }): ProjectDTO {
  return {
    id: r.id, slug: r.slug, name: r.name, description: r.description, active: r.active,
    color: r.color, gitRemoteKey: r.gitRemoteKey, repositoryUrl: r.repositoryUrl,
    productionUrl: r.productionUrl, stagingUrl: r.stagingUrl,
    aliases: r.aliases ?? [], localPaths: r.localPaths ?? [],
    lastActivityAt: r.lastActivityAt?.toISOString() ?? null,
    sessionCount: counts?.sessionCount ?? 0, memoryCount: counts?.memoryCount ?? 0,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString()
  }
}
```
Update `listProjects` to compute counts:
```ts
export async function listProjects(filter: { activeOnly?: boolean } = {}): Promise<ProjectDTO[]> {
  const db = useDb()
  const rows = await db.select({
    project: projects,
    sessionCount: sql<number>`(select count(*)::int from ${sessions} s where s.project_id = ${projects.id})`,
    memoryCount: sql<number>`(select count(*)::int from ${memories} m where m.project_id = ${projects.id})`
  }).from(projects).where(filter.activeOnly ? eq(projects.active, true) : undefined)
    .orderBy(sql`coalesce(${projects.lastActivityAt}, ${projects.createdAt}) desc`)
  return rows.map(r => toDTO(r.project, { sessionCount: r.sessionCount, memoryCount: r.memoryCount }))
}
```
(Other `toDTO` callers — `getProject`, `createProject`, `updateProject` — pass no counts → 0, which is fine; the page refetches the list. Optionally give `getProject` the same count subqueries.) Extend `UpdateProjectInput` + `updateProject`:
```ts
export interface UpdateProjectInput {
  name?: string; description?: string; active?: boolean
  color?: string | null; repositoryUrl?: string | null
  productionUrl?: string | null; stagingUrl?: string | null; aliases?: string[]
}
```
and in `updateProject`, add `if (patch.X !== undefined) update.X = patch.X` for each new field (`color`, `repositoryUrl`, `productionUrl`, `stagingUrl`, `aliases`).
- [ ] **Step 5 — endpoint** (`server/api/projects/[slug].patch.ts`): extend the zod `Body`:
```ts
const Body = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  active: z.boolean().optional(),
  color: z.string().nullable().optional(),
  repositoryUrl: z.string().nullable().optional(),
  productionUrl: z.string().nullable().optional(),
  stagingUrl: z.string().nullable().optional(),
  aliases: z.array(z.string()).optional()
})
```
- [ ] **Step 6 — composable** (`app/composables/useProjects.ts`): widen the `update` body type to include `color?: string | null; repositoryUrl?: string | null; productionUrl?: string | null; stagingUrl?: string | null; aliases?: string[]` (and keep create as-is).
- [ ] **Step 7 — `pnpm typecheck`** (errors expected in `projects.vue` until Task 4 — confirm the service/types/endpoint compile). **`pnpm build`** may fail on `projects.vue` references; that's fine pre-Task-4 — but typecheck the touched files are clean. Commit:
`git add server/db/schema/projects.ts server/db/migrations/ shared/types/tasks.ts server/services/projects.ts server/api/projects/ app/composables/useProjects.ts && git commit -m "feat(projects): color column + DTO/service/endpoint expose full model + counts"`

---

## Task 3: `useProjectColors` map + `<ProjectBadge>` component
**Files:** Modify `app/composables/useProjects.ts`; Create `app/components/ProjectBadge.vue`.

So a custom override set on `/projects` shows on EVERY surface (memories/sessions/tasks carry only the project slug), the badge resolves its colour from a single shared, cached projects query when no explicit `color` prop is given.

- [ ] **Step 1 — `useProjectColors` (in `app/composables/useProjects.ts`):** add a tiny cached helper returning a slug→override map (reuses the existing list query/cache):
```ts
const useProjectColors = () => {
  const q = useProjectList()
  const map = computed(() => {
    const m = new Map<string, string | null>()
    for (const p of (q.data.value ?? [])) m.set(p.slug, p.color ?? null)
    return m
  })
  return { map }
}
```
add `useProjectColors` to the returned object. (`useProjectList`'s DTO now has `color` from Task 2.)
- [ ] **Step 2 — implement `app/components/ProjectBadge.vue`:**
```vue
<script setup lang="ts">
import { computed } from 'vue'
import { projectColor } from '~/utils/project-color'
const props = withDefaults(defineProps<{ slug: string, name?: string | null, color?: string | null, to?: string | false }>(), { to: '/projects' })
const { map } = useProjects().useProjectColors()
// explicit color prop wins; else the shared override map; else the deterministic default
const c = computed(() => projectColor(props.slug, props.color ?? map.value.get(props.slug) ?? null))
const label = computed(() => props.name || props.slug)
</script>
<template>
  <component
    :is="to === false ? 'span' : 'NuxtLink'"
    :to="to === false ? undefined : to"
    class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium border max-w-full align-middle"
    :style="{ color: c, backgroundColor: c + '1f', borderColor: c + '40' }"
    :title="label"
  >
    <span class="size-1.5 rounded-full shrink-0" :style="{ backgroundColor: c }" />
    <span class="truncate">{{ label }}</span>
  </component>
</template>
```
(`useProjects` is auto-imported. `ProjectBadge.vue` at `components/` auto-imports as `<ProjectBadge>`. The shared `useProjectList` query dedupes across all badge instances.)
- [ ] **Step 3 — `pnpm typecheck`.** Commit: `git add app/composables/useProjects.ts app/components/ProjectBadge.vue && git commit -m "feat(projects): ProjectBadge (colored pill) + shared useProjectColors map"`

---

## Task 4: Projects page rework
**Files:** Modify `app/pages/projects.vue`.

READ the current file first. Keep the modals/CRUD structure; expand what's shown + editable.
- [ ] **Step 1 — list rows:** replace the plain name line with a `<ProjectBadge :slug="project.slug" :name="project.name" :color="project.color" :to="false" />` (or keep the name heading + a color dot), and add a metadata line showing: `git_remote_key` (if set, with a git icon), **`{{ project.sessionCount }} sessions · {{ project.memoryCount }} memories`**, and last-activity. Show a small color swatch (`<span class="size-3 rounded-full" :style="{backgroundColor: projectColor(project.slug, project.color)}"/>`) — import `projectColor` from `~/utils/project-color`.
- [ ] **Step 2 — edit modal:** add `UFormField`s for **Repository URL / Production URL / Staging URL** (`UInput`), **Aliases** (`UInputTags` if available, else a comma-separated `UInput` parsed to `string[]`), and a **Color** picker: a row of swatch buttons over `PROJECT_PALETTE` (clicking sets `editForm.color`) plus a "Reset to auto" button (sets `editForm.color = null`); the currently-selected/auto swatch is highlighted. Show `git_remote_key` + `local_paths` **read-only** (dimmed text — auto-derived). Extend `editForm` + `submitEdit`'s `updateProject(...)` call to send `color`, `repositoryUrl`, `productionUrl`, `stagingUrl`, `aliases`.
- [ ] **Step 3 — `pnpm typecheck` (0) + `pnpm build`.**
- [ ] **Step 4 — playwright-cli:** open `/projects`; confirm rows show colored badges + counts + git remote; open a project's edit modal, change the color via a swatch + set a URL, save, confirm it persists + the badge color changes. (login `test@example.com`/`testpassword123`.)
- [ ] **Step 5 — commit:** `git add app/pages/projects.vue && git commit -m "feat(projects): surface full model (urls/aliases/counts/git) + color picker on /projects"`

---

## Task 5: Wire `<ProjectBadge>` into project-scoped surfaces
**Files:** Modify `app/pages/memories.vue`, `app/pages/sessions/[id].vue`, `app/pages/tasks.vue`.

These surfaces carry only the project **slug**. Pass just `:slug` (no `:color`) — `<ProjectBadge>` resolves the colour from the shared `useProjectColors` map (Task 3), so a custom override set on `/projects` shows here too, and unoverridden projects use the deterministic default consistently. Default `:to` is `/projects`.
- [ ] **Step 1 — memories** (`app/pages/memories.vue`): replace the cycle-24 plain project `UBadge` on each card with `<ProjectBadge v-if="mem.project" :slug="mem.project" :to="false" />` (or `:to=\"'/projects'\"`). Keep the project FILTER control as-is.
- [ ] **Step 2 — sessions detail** (`app/pages/sessions/[id].vue`): replace the project `UBadge` (the `v-if="session.project"`/`meta.project` one in the left panel) with `<ProjectBadge v-if="meta.project" :slug="meta.project" />`.
- [ ] **Step 3 — tasks** (`app/pages/tasks.vue`): if a task card/row renders its `project` (it has a project select + server-side filter), add a `<ProjectBadge v-if="task.project" :slug="task.project" :to="false" />` where the task's project is/should be shown on the card. If tasks don't currently display the project on cards at all, ADD a small badge to the card. (Documents: only wire if the doc surface already shows a project; otherwise skip — out of scope.)
- [ ] **Step 4 — `pnpm typecheck` (0) + `pnpm build`.** playwright-cli: confirm the colored badge appears on a memory card and a session detail (and a task card if applicable).
- [ ] **Step 5 — commit:** `git add app/pages/memories.vue app/pages/sessions/[id].vue app/pages/tasks.vue && git commit -m "feat(projects): use ProjectBadge on memories, sessions, tasks"`

---

## Task 6: Docs + full gates
**Files:** Modify `docs/wiki/projects.md`.
- [ ] **Step 1 — wiki:** document the `color` column + `projectColor` palette/override + `<ProjectBadge>` + the projects-page surfacing (urls/aliases/counts/color picker). Note the DTO-color-everywhere follow-up.
- [ ] **Step 2 — full gates:** `pnpm typecheck && pnpm test && pnpm build` (all green).
- [ ] **Step 3 — commit:** `git add docs/wiki/projects.md && git commit -m "docs(projects): color + ProjectBadge + expanded projects UI"`

---

## Self-Review (after implementation)
- **Coverage:** color model (T1) · schema/DTO/counts (T2) · badge + shared color map (T3) · projects page surfacing + picker (T4) · wiring (T5) · docs (T6). Custom overrides propagate to all surfaces via `useProjectColors` (no per-DTO color plumbing needed).
- **Manual-verification:** UI validated via playwright-cli; only `projectColor` is unit-tested.
