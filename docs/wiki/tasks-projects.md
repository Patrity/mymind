---
title: Tasks + Projects (Kanban)
status: shipped
cycle: 4
updated: 2026-06-03
---

# Tasks + Projects (Kanban)

A simple kanban for todos and a light project shell. No AI.

## Data model
- `projects` (`server/db/schema/projects.ts`, since cycle 1): `slug` PK, `name`, `description`, `active`, timestamps.
- `tasks` (`server/db/schema/tasks.ts`): `id`, `title`, `description` (md), `status` (todo|in_progress|completed|blocked), `priority` (low|medium|high), `due_date`, `project` (soft ref slug), `order`, `created_at`, `updated_at`, `completed_at`, `deleted_at`. Indexes status, project.

## Services
- `server/services/tasks.ts`: `listTasks({status?,project?})`, `getTask`, `createTask`, `updateTask`, `moveTask`, `deleteTask` (soft). Pure `completedAtFor(status, now)` → sets `completed_at` only when status is 'completed', clears otherwise. `updated_at` bumps on every change.
- `server/services/projects.ts`: list/get/create (slug = `slugify(name)` if none; conflict throws → 409)/update/archive(active=false)/delete. `slugify` in `shared/utils/slugify.ts`.

## API
- `server/api/tasks/*`: `GET /api/tasks?status=&project=`, `POST`, `GET/PATCH/DELETE /api/tasks/[id]`, `POST /api/tasks/[id]/move`. zod v4; `dueDate` accepts `YYYY-MM-DD`.
- `server/api/projects/*`: `GET /api/projects?active=`, `POST` (409 dup slug), `GET/PATCH/DELETE /api/projects/[slug]`.

## UI
- `app/pages/tasks.vue` — 4-column board (Todo/In Progress/Completed/Blocked); cards show title, priority badge, due date (red if overdue), project chip; create/edit modal; inline status select to move; project filter. Composables `useTasks`/`useProjects`.
- `app/pages/projects.vue` — list, create, inline active toggle, edit, delete.
- Note: the "no project" select option uses a `__none__` sentinel (reka-ui USelect rejects empty-string values), mapped to `null` on submit.

## Cycle 10 polish
Kanban cards move via native drag-and-drop between columns (the per-card status dropdown was removed); a filter row adds project + priority `USelect`s (non-empty sentinels).

## Relations
Tasks link to a project via `project` (slug). Documents also carry a `project` column (cycle 1), so a project groups both — full cross-view (a project page listing its docs + tasks) is a future enhancement.
