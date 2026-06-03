# Tasks + Projects (Kanban) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** A 4-swimlane kanban with full task CRUD + audit, minimal project CRUD, tasks linkable to projects. No AI.

**Architecture:** `tasks` table + existing `projects` table; thin services + Nitro routes; kanban + projects Vue pages. Status transitions set/clear `completed_at`.

**Tech Stack:** Nuxt 4 + Nuxt UI v4, Drizzle/Postgres, Vitest, playwright-cli.

---

### Task 1: tasks schema + projects/tasks services (TDD the pure bits)
**Files:** `server/db/schema/tasks.ts` (+barrel), migration; `server/services/projects.ts`, `server/services/tasks.ts`, `shared/utils/slugify.ts`, `shared/types/tasks.ts`; `test/slugify.test.ts`, `test/task-status.test.ts`.
- [ ] `tasks` table: id uuid, title, description (text default ''), status (default 'todo'), priority (default 'low'), due_date timestamptz null, project text null, order integer default 0, created_at, updated_at, completed_at null, deleted_at null. Indexes status, project. Migrate + verify.
- [ ] `shared/utils/slugify.ts` `slugify(s)` (lowercase, hyphens, strip junk, collapse dashes) — TDD.
- [ ] pure `applyStatusChange(patch, status)` in tasks service: returns patch incl. `completedAt = status==='completed' ? new Date() : null` and the status — TDD a version that takes (currentStatus, newStatus) → `{ completedAt: Date|null }` (use an injected `now` to keep it testable, or test the null-vs-set branch logic without asserting exact time).
- [ ] `projects.ts`: listProjects({activeOnly?}), getProject, createProject({name,description?,slug?}) (slugify name if no slug; conflict → 409-ish error), updateProject, archiveProject, deleteProject. All live (no deletedAt on projects; archive = active false).
- [ ] `tasks.ts`: listTasks({status?,project?}) live, getTask, createTask, updateTask (merge fields; recompute completedAt on status change; bump updatedAt), moveTask(id,{status,order}), deleteTask (soft). DTOs in shared/types.
- [ ] typecheck + test + commit.

### Task 2: projects + tasks API
**Files:** `server/api/projects/{index.get,index.post,[slug].get,[slug].patch,[slug].delete}.ts`; `server/api/tasks/{index.get,index.post,[id].get,[id].patch,[id].delete}.ts`, `server/api/tasks/[id]/move.post.ts`.
- [ ] Thin handlers over the services; zod v4 validation (`z.enum` for status/priority). `GET /api/tasks?status=&project=`. Auth via existing middleware.
- [ ] Smoke (dev + cookie): create project, create task in it, PATCH status→completed (completed_at set), move, list by status. Commit.

### Task 3: composables + Kanban UI
**Files:** `app/composables/useTasks.ts`, `app/composables/useProjects.ts`, `app/pages/tasks.vue`, sidebar nav.
- [ ] Composables wrap the APIs.
- [ ] `tasks.vue`: 4 columns (Todo/In Progress/Completed/Blocked) from `listTasks` grouped by status. Card: title, priority `UBadge`, due date, project chip. "New task" button → `UModal` (title, description `UTextarea`, status, priority, due `UInput type=date`, project `USelect` from useProjects). Click card → edit modal (same fields) + delete. Move via per-card status buttons or a select; (drag optional). Optional project filter `USelect`. Sidebar "Tasks" nav (`i-lucide-square-kanban`).
- [ ] typecheck + build + commit.

### Task 4: Projects UI
**Files:** `app/pages/projects.vue`, sidebar nav.
- [ ] List projects (name, description, active switch → archive/unarchive), create/edit modal, delete (confirm). Sidebar "Projects" nav (`i-lucide-folder-kanban`).
- [ ] typecheck + build + commit.

### Task 5: E2E + handover + merge
- [ ] Gates typecheck/build/test.
- [ ] playwright-cli: board renders 4 columns; create a task; move to Completed → appears there; create a project; assign a task to it. Screenshot.
- [ ] Handover; wiki `tasks-projects.md`; roadmap cycle-4 → shipped. Final review; fix blockers; merge.

---

## Self-Review
Coverage: tasks schema+audit (T1) ✓ · project+task services/API (T1,T2) ✓ · kanban 4 swimlanes + CRUD (T3) ✓ · projects CRUD (T4) ✓ · validation/docs/merge (T5) ✓. Pure units: slugify, status→completedAt. No AI, fully local-testable. Drag-drop explicitly optional.
