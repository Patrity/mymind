---
title: Tasks + Projects (Kanban)
cycle: 4
status: spec
date: 2026-06-03
supersedes: none
---

# Cycle 4 — Tasks + Projects (Kanban)

## Purpose
A simple kanban for todo items and a light project shell that ties docs + tasks together. No AI. Projects are minimal tags (name/description/active, slug PK — already exist from cycle 1); tasks are first-class with status swimlanes and an audit trail.

## Components

### Data model
- `projects` (exists): `slug` PK, `name`, `description`, `active`, timestamps. Add CRUD this cycle.
- `tasks` (new): `id` uuid, `title` text, `description` text (markdown), `status` text ('todo'|'in_progress'|'completed'|'blocked', default 'todo'), `priority` text ('low'|'medium'|'high', default 'low'), `due_date` timestamptz null, `project` text null (soft ref projects.slug), `order` integer (manual ordering within a column, default 0), audit: `created_at`, `updated_at`, `completed_at` null, `deleted_at` null. Indexes on status, project.

### Services + API
- `server/services/projects.ts`: list (active filter), get, create (slugify name if no slug), update, archive (active=false), delete. API `server/api/projects/*` (GET list, POST, GET/PATCH/DELETE [slug]).
- `server/services/tasks.ts`: list (filters: status, project), get, create, update (sets `completed_at` when status→completed, clears when leaving completed; bumps `updated_at`), move (status + order), delete (soft). API `server/api/tasks/*`.
- Audit: `updated_at` on every change; `completed_at` set/cleared on status transitions.

### UI
- `app/pages/tasks.vue` — Kanban board: 4 columns (Todo / In Progress / Completed / Blocked). Cards show title, priority badge, due date, project chip. Create-task button + modal (title, description md, status, priority, due, project select). Click card → edit modal. Move between columns (buttons or drag — buttons acceptable; drag is a nice-to-have). Optional project filter dropdown.
- `app/pages/projects.vue` — list projects (name, description, active toggle, task/doc counts optional), create/edit modal, archive. 
- Sidebar nav: "Tasks" (`i-lucide-square-kanban`) + "Projects" (`i-lucide-folder-kanban`).
- Relations: task `project` select pulls from projects; documents already have a `project` column (cycle 1) — a project's page can later list its docs+tasks (light: show counts; full cross-linking optional).

## Testing & validation
- Unit (vitest): status-transition logic pure-testable (a `applyStatusChange(task, newStatus)` helper that sets/clears completed_at) ; slugify helper.
- Integration: create project → create task in it → move task to completed (completed_at set) → move back (cleared) → list by status returns correct swimlanes.
- `playwright-cli`: board renders 4 columns; create a task; move it to Completed; it appears in the Completed column.
- Gates: typecheck/build/test.

## Non-goals
Subtasks, checklists, recurring tasks, task comments, time tracking, calendar view, notifications/reminders (later). Drag-and-drop is optional (buttons suffice).

## Definition of done
A working kanban with 4 swimlanes and full task CRUD + audit, minimal project CRUD, tasks linkable to projects. Wiki `tasks-projects.md`; handover; roadmap cycle-4 → shipped.
