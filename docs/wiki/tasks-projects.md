---
title: Tasks + Projects (Kanban)
status: shipped
cycle: 4
updated: 2026-06-17
---

# Tasks + Projects (Kanban)

> **Project entities are now documented in [projects.md](projects.md)** (canonical git-keyed projects, dashboard, document/session/memory association, merge). This page covers only the **tasks/kanban** side.

A simple kanban for todos. No AI.

## Data model
- `tasks` (`server/db/schema/tasks.ts`): `id`, `title`, `description` (md), `status` (todo|in_progress|completed|blocked), `priority` (low|medium|high), `due_date`, `project` (soft ref slug — links to `projects.slug`), `order`, `created_at`, `updated_at`, `completed_at`, `deleted_at`. Indexes status, project.
- `projects` schema: see [projects.md](projects.md). Tasks reference projects by the denormalized `project` slug text column (no `project_id` FK on tasks).

## Services
- `server/services/tasks.ts`: `listTasks({status?,project?})`, `getTask`, `createTask`, `updateTask`, `moveTask`, `deleteTask` (soft). Pure `completedAtFor(status, now)` → sets `completed_at` only when status is 'completed', clears otherwise. `updated_at` bumps on every change.
- `server/services/projects.ts`: see [projects.md](projects.md) for the full service description.

## API
- `server/api/tasks/*`: `GET /api/tasks?status=&project=`, `POST`, `GET/PATCH/DELETE /api/tasks/[id]`, `POST /api/tasks/[id]/move`. zod v4; `dueDate` accepts `YYYY-MM-DD`.
- Projects API: see [projects.md](projects.md).

## UI
- `app/pages/tasks.vue` — 4-column board (Todo/In Progress/Completed/Blocked); cards show title, priority badge, due date (red if overdue), `<ProjectBadge>` chip; create/edit modal; inline status select to move; project filter. Composables `useTasks`/`useProjects`.
- Note: the "no project" select option uses a `__none__` sentinel (reka-ui USelect rejects empty-string values), mapped to `null` on submit.
- Projects UI: see [projects.md](projects.md) — the `/projects` index, per-project dashboard with Sessions/Tasks/Memories/Documents tabs, edit modal, color picker, and merge UI all live there.

## Cycle 10 polish
Kanban cards move via native drag-and-drop between columns (the per-card status dropdown was removed); a filter row adds project + priority `USelect`s (non-empty sentinels).

## Relations
Tasks link to a project via `project` (slug). The project dashboard (`/projects/[slug]`) lists that project's Sessions, Tasks, Memories, and Documents — shipped in cycles 25–26. See [projects.md](projects.md).
