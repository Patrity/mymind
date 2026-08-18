---
title: Tasks + Projects (Kanban)
status: shipped
cycle: 58
updated: 2026-08-18
mymind_id: 326ed2ea-4664-4406-90dc-17623d17ee55
mymind_hash: d18ee20f51d82c559aab1154019e1d3a336a17bfb60eba0b2586b39023849e75
---

# Tasks + Projects (Kanban)

> **Project entities are now documented in [projects.md](projects.md)** (canonical git-keyed projects, dashboard, document/session/memory association, merge). This page covers only the **tasks/kanban** side.

A kanban board with **user-defined columns** (cycle 58). Columns are data you manage — add, rename,
recolour, reorder, delete — while the *meaning* code depends on stays fixed to a closed four-value
`kind`. No AI.

## Data model

- **`task_columns`** (`server/db/schema/task-columns.ts`) — the board's columns:
  - `id` uuid pk
  - `name` text — user-facing, editable. **Code never reads this.** A `switch`/comparison on a
    column's name is a defect.
  - `kind` text — one of `open | started | done | blocked`. **This is what code reads.** Enforced
    twice: a DB `CHECK` constraint (`task_columns_kind_check`, migration `0035`) and
    `z.enum(TASK_COLUMN_KINDS)` at the column API routes — `kind` is chosen once at column
    creation and is **not editable afterwards** (the API route's PATCH schema has no `kind` key at
    all, so a client sending one is silently stripped; the form UI also just doesn't offer it).
    Changing a column's kind after the fact would silently reclassify every card in it — flipping a
    "Done" column to `open` would un-complete every task in it and clear `completedAt`.
  - `color` text — one of the app's semantic aliases: `primary | secondary | success | info |
    warning | error | neutral` (`TASK_COLUMN_COLORS`, `shared/types/task-columns.ts`). Never a hex
    value, never a raw Tailwind palette name — see **Colour** below.
  - `position` integer — left-to-right board order.
  - `is_default` boolean — **exactly one `true` row per `kind`**, enforced by a partial unique
    index (`task_columns_one_default_per_kind` on `(kind) WHERE is_default`), not just application
    care. This is the compat mapping's resolution target (below) — if a kind ever lost its default,
    `create_task(status=...)` would have nothing to resolve to and fail at runtime.
  - `created_at` timestamptz.
- **`tasks`** (`server/db/schema/tasks.ts`): `id`, `title`, `description` (md), **`column_id`** (uuid,
  FK → `task_columns.id`, `NOT NULL`, indexed by `tasks_column_idx`), `priority`
  (low|medium|high), `due_date`, `project` (soft ref slug — links to `projects.slug`), `order`,
  `created_at`, `updated_at`, `completed_at`, `deleted_at`.
  **`tasks.status` no longer exists as a column.** It was shadowed alongside `column_id` for the
  length of the cycle-58 build (so every task boundary stayed green and reversible) and dropped in
  the cycle's final migration (`0036`, `ALTER TABLE tasks DROP COLUMN status`) once every consumer
  read columns. A task's status is now **derived** by joining `task_columns.kind` and mapping it
  back through `statusForKind()` — see the compat mapping below. There is no raw `tasks.status` to
  read or filter on anywhere in this codebase; every service query that used to `eq(tasks.status,
  …)` now does `.innerJoin(taskColumns, eq(tasks.columnId, taskColumns.id))` and filters/derives on
  `taskColumns.kind`.
- `projects` schema: see [projects.md](projects.md). Tasks reference projects by the denormalized
  `project` slug text column (no `project_id` FK on tasks).

## The compatibility seam — `TaskStatus` is an alias vocabulary, not storage

`TaskStatus` (`shared/types/tasks.ts`) is still exactly `'todo' | 'in_progress' | 'completed' |
'blocked'`, and every pre-existing surface — the three task API routes, the three `create_task`/
`edit_task`/`search_tasks` MCP tools, `server/lib/agent/context.ts`'s live-context injection —
still accepts and returns those four values, unchanged. **What changed is what they mean.** They
are no longer a column in the database; they are a fixed **alias vocabulary** that resolves through
`server/lib/tasks/status-kind.ts` (pure, no I/O — the hinge the whole seam turns on):

```ts
kindForStatus('todo')        // -> 'open'
kindForStatus('in_progress') // -> 'started'
kindForStatus('completed')   // -> 'done'
kindForStatus('blocked')     // -> 'blocked'
statusForKind(kind)          // the inverse — throws on anything outside the four kinds
```

Both directions **throw on an unrecognised value** rather than silently defaulting — a silent
fallback would file a task into the wrong column, or read a task as the wrong status, forever.

- **Writes** — `create_task`, `edit_task`, `POST /api/tasks`, `PATCH /api/tasks/[id]`,
  `POST /api/tasks/[id]/move` keep accepting bare `status`. `server/services/tasks.ts`'s
  `resolveColumn()` turns it into **the default column of the matching kind**
  (`defaultColumnFor(kindForStatus(status))`) unless an explicit `columnId` is also given, in which
  case `columnId` wins. An agent calling `create_task(status='todo')` lands in whichever column
  currently carries `kind='open'` and `is_default=true` — today that's the seeded "Todo" column,
  but if you rename it to "Inbox" tomorrow the call keeps working unchanged.
- **Reads** — `search_tasks(status=…)`, `GET /api/tasks?status=…`, `agent/context.ts`'s open-task
  query, Home's active-tasks panel and overdue filtering — filter on the **joined column's `kind`**,
  never on a stored string. A task sitting in a custom "Playtesting" column with `kind='started'`
  correctly counts as `in_progress` everywhere, with no per-surface changes. Every DTO's `status`
  field (`TaskDTO`, `TaskSummaryDTO`) is likewise **derived** at read time via `statusForKind`, not
  stored.
- **`completedAtFor(kind, now)`** (`server/services/tasks.ts`) stamps `completed_at` on transition
  into **any** `kind='done'` column — not on the literal string `'completed'`, and not only the
  column named "Completed". Moving a card into a custom done-kind column (however it's named)
  stamps it; moving out of one clears it.
- The board (and only the board) additionally accepts and returns **`columnId`** on all three task
  routes, so the UI can place a card in a *specific* column rather than merely a kind. That's the
  one surface that needs to know columns exist at all — every other consumer only ever sees the
  four-value alias.

**This mapping is closed and load-bearing in both directions.** `task_columns.kind` is
DB-constrained to exactly `open | started | done | blocked` (see Data model above) specifically
because `toDTO()` calls `statusForKind(column.kind)` on **every live task read** — an out-of-vocabulary
`kind` would make every task in that column throw on read, not just render wrong.

## Column colour

Each column's `color` drives two things, from one field:

1. **The board tint** on the column itself.
2. **The status badge colour everywhere else in the app** that shows a task — currently the task
   rows on a project's dashboard (`app/pages/projects/[slug].vue`). The badge's **label** reads the
   column's `name` (falling back to the status alias only if the column can't be resolved:
   `columnById.get(task.columnId)?.name ?? task.status.replace('_', ' ')`), and its **colour**
   reads `columnById.get(task.columnId)?.color`. Renaming "Completed" to "Shipped" and recolouring
   it therefore repaints every badge referencing that column with no code change anywhere.

**The trap this must avoid, and why it isn't done as an interpolated class.** Column colour arrives
as *data*, so the obvious tint implementation is a constructed class —
`` :class="`bg-${column.color}/5`" ``. **That silently renders nothing**: Tailwind's scanner is
static and only emits classes it can see literally in source, so an interpolated class name is
invisible to it and gets purged from the build — the element renders with no background, and a
naive "does the class exist" test still passes. The board tint is therefore a **static lookup map
with every class string written out literally** (`app/pages/tasks.vue`):

```ts
const TINT: Record<TaskColumnColor, string> = {
  primary: 'bg-primary/5', secondary: 'bg-secondary/5', success: 'bg-success/5',
  info: 'bg-info/5', warning: 'bg-warning/5', error: 'bg-error/5', neutral: 'bg-elevated'
}
```

The column-colour **picker** (`ColumnFormModal.vue`) keeps a second, independently-maintained
static map, `SWATCH`, for the same reason but a different shape: `TINT` is a 5%-opacity board wash,
unusable as a solid swatch fill, and isn't exported. Both maps are `Record<TaskColumnColor, …>`, so
Typescript catches the two ever drifting out of sync on the color *set* (adding/removing a value to
`TASK_COLUMN_COLORS`), just not a value-level mismatch.

Seeded columns keep the same colours the old hardcoded `statusColor` map used (Todo `neutral`, In
Progress `primary`, Completed `success`, Blocked `error`), so nothing changes appearance on
deploy. That old map — `app/pages/projects/[slug].vue`'s `const statusColor: Record<string,
...> = { todo: 'neutral', … }` — is **deleted**; colour comes from the column now, not a
hardcoded switch on status.

## Deleting a column

Deleting a column (`DELETE /api/task-columns/[id]`, `deleteColumn()` in
`server/services/task-columns.ts`) always requires a choice for its existing cards, made in
`DeleteColumnModal.vue`:

1. **Delete the cards** — soft-delete via the same `deleteTask()` every other delete in this app
   uses (sets `deleted_at`; recoverable). Never a raw `db.delete(tasks)`, which would skip that.
2. **Move them to →** a `USelectMenu` of the remaining columns (`mode: 'reassign'`,
   `targetColumnId` required and must differ from the column being deleted).

**One deletion is always refused: the last column of any `kind`.** If no `done` column existed,
`create_task(status='completed')` would have nothing to resolve to and
`search_tasks(status='completed')` would silently return nothing — the compat seam above would
break. The refusal is a `409` with the reason as `statusMessage` (`"<name>" is the only <kind>
column — rename it instead of deleting it`), rendered inline in the modal via `UAlert`, never a
generic toast. Renaming is always available instead — "Done" → "Shipped" is free, since code reads
`kind`, not `name`.

**A constraint the plan didn't anticipate: the FK is `ON DELETE NO ACTION`, and Postgres enforces
it against soft-deleted rows too.** `deleted_at IS NOT NULL` is invisible to the foreign key —
a task that was soft-deleted through this app *before* today, or during this same delete call, still
carries a live `column_id` pointing at the doomed column, and the `DELETE FROM task_columns` would
throw a raw FK violation if left alone. So both delete modes repoint **every** referencing row, not
just the live ones a user would see:

- `mode: 'delete'` soft-deletes every live card via `deleteTask()`, then repoints any straggler
  (including the ones just soft-deleted, plus any older dead rows) to a sibling column of the same
  kind — `affected` in the response counts only the user-visible soft-deletes.
- `mode: 'reassign'` moves every live card's `column_id` to the target, then repoints stragglers the
  same way.

Every column mutation (create/update/reorder/delete) calls `publishChange({ resource: 'task', … })`
— deliberately **not** a dedicated `taskColumn` member of `ResourceName`. `task` already invalidates
the board and the Home panel (`app/utils/live-dispatch.ts`), which is the entire audience for a
column change; adding a union member would need a matching dispatch entry for no added reach. One
consequence: `useColumnList()` (`app/composables/useTaskColumns.ts`) is **not** wired into SSE
invalidation — every column-mutating component (`ColumnFormModal`, `DeleteColumnModal`, the
column-reorder handler in `tasks.vue`) calls the query's own `refetch()` explicitly after a
successful write, the same pattern `useTasks.ts`'s mutations already use.

## Services

- `server/services/tasks.ts`: `listTasks({status?, project?, columnId?})`, `getTask`, `createTask`,
  `updateTask`, `moveTask`, `deleteTask` (soft), `restoreTask`. `resolveColumn()` is the private
  compat-seam resolver described above. Pure `completedAtFor(kind, now)` → sets `completed_at`
  only when transitioning into a `kind='done'` column, clears otherwise. `updated_at` bumps on
  every change. `listTasksSummary`/`countTasks`/`toTaskSummaryDTO` back the MCP `search_tasks` tool
  and, like every other reader here, join `task_columns` and never read a stored status.
- `server/services/task-columns.ts`: `listColumns()` (ordered by `position`), `defaultColumnFor(kind)`
  (throws if a kind has no default), `createColumn`, `updateColumn` (name/color only), `reorderColumns`,
  `deleteColumn` (the delete-with-cards flow above).
- `server/services/projects.ts`: see [projects.md](projects.md) for the full service description.

## API

- `server/api/tasks/*`: `GET /api/tasks?status=&project=&columnId=`, `POST`,
  `GET/PATCH/DELETE /api/tasks/[id]`, `POST /api/tasks/[id]/move`. `status` (the closed
  `todo|in_progress|completed|blocked` enum) is **kept exactly as it was and never removed** on
  every route that accepts it; `columnId` is additive. zod v4; `dueDate` accepts `YYYY-MM-DD`.
- `server/api/task-columns/*` (new): `GET /` (list, ordered by position), `POST /` (create —
  `name`, `kind`, `color`, `position?`), `PATCH /[id]` (name/color only — no `kind` key in the
  schema, so a client can't smuggle one through), `DELETE /[id]` (body `{ mode, targetColumnId? }`,
  409 on refusal), `POST /reorder` (body `{ ids: string[] }`, full reorder in one call). All are
  thin wrappers over `server/services/task-columns.ts`.
- Projects API: see [projects.md](projects.md).

## UI

- `app/pages/tasks.vue` — renders columns from live `task_columns` data (`useTaskColumns()`),
  ordered by `position` — **never** re-sorted or re-capped client-side. Cards group by `columnId`,
  not by any status string. Create/edit modal, project + priority filter row (both `USelectMenu` —
  see below), column tint (`TINT`, above).
  - **Column management** lives on the same page: `ColumnHeader.vue` (name, card-count badge, a
    dropdown with Rename/Change colour/Delete), `ColumnFormModal.vue` (create — name + kind
    (locked after creation) + colour swatch picker; edit — name + colour only),
    `DeleteColumnModal.vue` (the two-mode delete flow above). An "add column" control sits at the
    end of the board.
  - **Drag** uses `@vueuse/integrations/useSortable`, replacing the old native HTML5 drag — see
    **Drag behaviour** below for the exact mechanics and the trap that governs them.
  - **All 8 `<USelect>` on this page are now `<USelectMenu>`** — this was the only page in the app
    still on plain `USelect`; every other project dropdown had already migrated.
- `app/pages/projects/[slug].vue` — the project dashboard's task rows read their badge label/colour
  from the joined column (via a local `columnById` map built from `useColumnList()`), falling back
  to the status alias only if the column lookup misses. See Column colour above.
- Note: the "no project" select option uses a `__none__` sentinel (reka-ui rejects empty-string
  values), mapped to `null` on submit.
- Projects UI: see [projects.md](projects.md) — the `/projects` index, per-project dashboard with
  Sessions/Tasks/Memories/Documents tabs, edit modal, color picker, and merge UI all live there.

## Drag behaviour

Two independent `useSortable` instances share the page: one **per column** for cards (all in group
`'tasks'` so a card can cross columns), and one on the **board container** for column reordering
(drag a column's header, `.column-drag-handle`).

**The trap, binding on every future call site: emit the reorder from a deep watch on the bound
list, never from `onEnd`.** `useSortable`'s default `onUpdate` (same-list reorder) splices the
bound array only after the drop completes — reading it inside `onEnd` races that splice and
persists the **pre-drop** order, so the dragged row visibly snaps back after the next refetch. This
repo hit this before `AssignmentChain.vue` was written and the fix is documented there; cycle 58's
card board is the second real implementation of the pattern (see the inline comments this task
added at both call sites, below).

**"Watch, not `onEnd`" is necessary but not sufficient — the binding shape matters too.**
`@vueuse/integrations/useSortable`'s internal `moveArrayElement` branches on whether the bound list
is a Vue `ref` or a plain array living inside `reactive()`:

- **`ref`-bound** (`AssignmentChain.vue`, and `tasks.vue`'s column-reorder list, `orderedColumns`)
  — `moveArrayElement` clones the array, splices the *detached copy*, and reassigns the `ref`'s
  `.value` **once**. The watch fires once, on a fully-settled array. A bare deep watch is correct
  and sufficient here.
- **A plain array nested in `reactive()`** (`tasks.vue`'s per-column card lists, `columnsTasks`) —
  the array is mutated **live, in place, in two steps**: a synchronous removal, then a
  `nextTick`-deferred re-insertion. A deep watch fires on **both** steps. Reading state on the
  first fire (item removed, not yet reinserted) diffs a half-settled array — confirmed during this
  cycle's browser validation: dragging a card to the top of its column, past another task sharing
  its stored `order`, produced a diff that silently dropped the dragged card from what persisted.
  The fix is a **macrotask defer** (`setTimeout(fn, 0)`, which is spec-guaranteed to run after every
  currently-queued microtask/`nextTick` has drained) between the watch firing and reading the
  array — not `await nextTick()`, which only waits for Vue's own queue and can still land on the
  intermediate state.

Both `tasks.vue`'s `useSortable` call sites (line ~243, per-column cards; line ~295, column
reorder) and `AssignmentChain.vue`'s own call site now carry an inline comment naming this
distinction, so a future reader neither "fixes" `AssignmentChain.vue` (it's correct as written) nor
assumes a *new* reactive-array-bound call site is safe with a bare watch (it isn't — it needs the
same macrotask defer `tasks.vue`'s card lists use).

Cross-column card drops additionally undo Sortable's own DOM mutation (`removeNode` +
`insertNodeAt` back to the origin) before splicing the two bound arrays a tick later — `useSortable`'s
default `onUpdate` only wires same-list reorders, so a drag between two separate `useSortable`
instances/arrays has to be handled by hand. `onStart`/`onEnd` guard a `isDragging` flag so a live
SSE-driven refetch that lands mid-drag can't rebuild the columns out from under the user's hand.

## Relations

Tasks link to a project via `project` (slug). The project dashboard (`/projects/[slug]`) lists that
project's Sessions, Tasks, Memories, and Documents — shipped in cycles 25–26. See
[projects.md](projects.md).

## History

- **Cycle 4** — original kanban: fixed four-column board (Todo/In Progress/Completed/Blocked),
  `tasks.status` as a closed enum column.
- **Cycle 10** — native HTML5 drag-and-drop between columns; project + priority filter row.
- **Cycle 58** — dynamic, user-defined columns (this page's current model). `tasks.status` dropped
  entirely; `TaskStatus` survives only as a compat alias vocabulary resolved through
  `task_columns.kind`. Drag rewritten onto `useSortable`. All remaining `USelect` swapped to
  `USelectMenu`. See [`../handovers/2026-08-18-dynamic-board-columns.md`](../handovers/2026-08-18-dynamic-board-columns.md).
