---
title: Tasks + Projects (Kanban)
cycle: 4
status: shipped
date: 2026-06-03
shipped:
  - tasks table (title, description md, status todo|in_progress|completed|blocked, priority low|medium|high, due_date, project, order, audit created/updated/completed_at, soft delete)
  - tasks + projects services with TDD'd pure helpers (slugify, completedAtFor) — status→completed sets completed_at, leaving clears it; updated_at bumps every change
  - projects + tasks REST API (zod v4; slug auto-derive + 409 on conflict; dueDate accepts YYYY-MM-DD)
  - Kanban UI (4 swimlanes, cards with priority badge / due / project chip, create/edit/move/delete, project filter)
  - Projects management UI (list, create, inline active toggle, edit, delete)
  - sidebar nav: Tasks + Projects
deferred:
  - "Drag-and-drop between columns (status changed via inline select instead) -> polish"
  - "Subtasks/checklists, recurring tasks, task comments, time tracking, calendar view, reminders/notifications -> later"
  - "doc<->project<->task cross-linking surface (projects page listing its docs+tasks) -> light counts only this cycle; full cross-view later"
  - "Manual card reordering within a column (order column exists + move supports it; UI just appends) -> polish"
next_seam: "Cycle 5 (Memory + MCP server + hook endpoints): the last big one. Reimplement the bridget memory data model + hybrid RRF search (reuse cycle-2 embeddings/rrf/chat), enrichment loop, HTTP hook endpoints for Claude Code/Hermes, and MCP tools exposing memories/docs/projects/tasks (all now exist as targets). Then cycle 6 (Clipboard) ports copipasta."
validation: "typecheck + build + 49 vitest tests; playwright-cli E2E (create project, 4-column board, create task in Todo, move to Completed with completed_at audit, edit priority). USelect empty-value bug found + fixed."
---

# Cycle 4 — Tasks + Projects (Kanban) (handover)

A simple, no-AI kanban over the existing project shell. Four swimlanes, full task CRUD with an audit trail (`completed_at` set/cleared on status transitions, `updated_at` on every change), and minimal project CRUD. Tasks link to projects; documents already carry a `project` column (cycle 1), so a project ties docs + tasks together.

## Key decisions
- **Status drives audit**: the service's `completedAtFor(status, now)` is the single source of the completed-at rule; routes are zero-logic.
- **Inline status select over drag-drop**: more reliable than HTML5 DnD; the `order` column + `move` endpoint already support manual ordering when a DnD UI is added later.
- **`__none__` sentinel** for the "no project" select option (reka-ui rejects empty-string USelect values).

## Where things live
- Schema `server/db/schema/tasks.ts`; services `server/services/{tasks,projects}.ts` (pure helpers `completedAtFor`, `slugify` in `shared/utils/slugify.ts`); types `shared/types/tasks.ts`.
- API `server/api/tasks/*` + `server/api/projects/*`.
- UI `app/pages/{tasks,projects}.vue`; composables `app/composables/{useTasks,useProjects}.ts`.
