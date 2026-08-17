---
title: Dynamic board columns — user-defined kanban lists with fixed semantics
cycle: 58
date: 2026-08-17
status: spec — approved in brainstorm, not yet planned
related:
  - ../../wiki/tasks-projects.md (the board and task model this rewrites)
  - ../../wiki/mcp.md (create_task / edit_task / search_tasks — the contract this must not break)
  - ../../wiki/triage.md (cycle 57 — triage now writes tasks automatically, so the board has a machine writer)
  - ../specs/2026-06-12-live-reactivity-design.md (the publishChange contract every mutation rides)
  - ../../handovers/2026-08-16-capture-triage.md (cycle 57 — most recent)
closes:
  - "MyMind task a1575210 (New backlog column on tasks) — subsumed: you add a Backlog column yourself"
  - "MyMind task 7be76abc (project select dropdowns → USelectMenu) — the 8 remaining are all in tasks.vue"
---

# Dynamic board columns (cycle 58)

## Why

`TaskStatus` is a closed union of four values — `todo | in_progress | completed | blocked` — hardcoded
in `shared/types/tasks.ts` and switched on in eight places. The board renders exactly those four
columns, in that order, forever.

That was fine when the board was a personal todo list. Two things changed it:

**The vocabulary can't express real work.** A game project wants "Playtesting"; a remodel wants
"Awaiting quote". Neither is `in_progress` in any useful sense, and there is no way to say so. The
immediate trigger was wanting a **Backlog** column — but adding a fifth hardcoded value would have
been the same mistake a fifth time, and the next column would need another migration.

**The board now has a machine writer.** As of cycle 57, capture triage creates tasks automatically
(Task bar at 0.70, first prod auto-apply 2026-08-17). Volume is going up and it is no longer all
hand-entered, which makes the board's organisation matter more than it did.

## What this builds

Columns become data you manage — add, rename, reorder, delete — while the *meaning* code depends on
stays fixed. Both halves are load-bearing: without user-defined names the feature is pointless;
without fixed semantics, `completedAt`, overdue filtering, the agent's own context, and every MCP
integration break the first time a column is renamed.

### Decisions locked in the brainstorm

| Decision | Choice |
|---|---|
| Column meaning | Each column carries a **`kind`**: `open \| started \| done \| blocked`. Code switches on `kind`, never on the name. |
| Board scope | **One global column set.** No per-project boards; the existing project filter is unchanged. |
| Scope of this cycle | Columns + the drag rewrite (`useSortable`, in-column reordering) + the 8 `USelect` → `USelectMenu` swaps. |
| Deferred to cycle 59 | Card content/density, filtering + saved filters, grouping. Pure presentation; reads better once columns settle. |
| Deleting a non-empty column | The user chooses: **delete the cards** (soft) or **move them to a named column**. |
| Column color | Each column carries a semantic-alias `color`, used for the board tint **and** for that task's status badge app-wide. |

## Data model

**New table `task_columns`:**

| Column | Type | Note |
|---|---|---|
| `id` | uuid pk | |
| `name` | text not null | User-facing. Code never reads this. |
| `kind` | text not null | `open \| started \| done \| blocked` |
| `color` | text not null | One of the app's semantic aliases (see Column color) |
| `position` | integer not null | Left-to-right board order |
| `is_default` | boolean not null | Exactly one per `kind` — the compat mapping's resolution target |
| `created_at` | timestamptz | |

**`tasks`:** `status` (text) is replaced by `column_id` (uuid, FK → `task_columns.id`, indexed).
Semantics come from joining `task_columns.kind`. The existing `tasks_status_idx` is replaced by an
index on `column_id`.

`tasks.order` (already present, currently unused for manual placement) becomes the within-column
ordering key.

## The compatibility seam

This is the part that must not be got wrong. Your Claude Code sessions call `create_task` and
`search_tasks` constantly, and `server/lib/agent/context.ts` injects your open tasks into every
agent turn. None of that may break, and none of it should need to learn about columns.

**Every existing surface keeps the four-value vocabulary**, reinterpreted as a *kind*:

- **Writes** — `create_task`, `edit_task` (`server/lib/agent/tools.ts`), `POST /api/tasks`,
  `PATCH /api/tasks/[id]`, `POST /api/tasks/[id]/move` — keep accepting
  `todo | in_progress | completed | blocked` and resolve to **the default column of the matching
  kind** (`todo`→`open`, `in_progress`→`started`, `completed`→`done`, `blocked`→`blocked`). An agent
  calling `create_task(status='todo')` works unchanged, forever.
- **Reads** — `search_tasks(status=…)`, `agent/context.ts`'s `inArray(status, ['todo','in_progress'])`,
  Home's active-tasks panel, overdue filtering — filter on **`kind`**. A task sitting in a custom
  "Playtesting" column with `kind='started'` correctly counts as in-progress everywhere, with no
  per-surface changes.
- `completedAtFor()` (`server/services/tasks.ts`) stamps on transition into any **`kind='done'`**
  column, not on the literal string `'completed'`.
- The board additionally accepts and returns **`column_id`**, so the UI can place a card in a
  *specific* column rather than merely a kind. That is the only surface that needs to know columns
  exist.

**The eight sites that switch on `TaskStatus` today**, all of which this touches:
`shared/types/tasks.ts` · `app/composables/useTasks.ts` · `app/pages/tasks.vue` ·
`server/services/tasks.ts` · `server/lib/agent/context.ts` · `server/lib/agent/tools.ts` (×3 tool
schemas) · `server/api/tasks/index.post.ts` · `server/api/tasks/[id].patch.ts` ·
`server/api/tasks/[id]/move.post.ts`.

## Board UI

`app/pages/tasks.vue` renders columns from `task_columns` ordered by `position`.

**Drag moves to `useSortable`** (VueUse), replacing the native HTML5 drag. Dragging between columns
sets `column_id`; dragging within a column sets `order`. This is not gold-plating: manual in-column
reordering is impractical on the current HTML5 implementation, and there is a standing preference on
record to move this specific board to `useSortable`.

> **Known trap, binding on the implementer:** emit the reorder from a **deep watch on the list**, not
> from `onEnd`. The `onEnd` race makes rows snap back — this repo has hit it before.

**Column management** lives on the same surface: add, rename, reorder (drag the header), delete.

**Deleting a column** opens a modal stating the card count, with two choices:
1. **Delete the cards** — soft-delete (`deleteTask`), recoverable, consistent with every other delete
   in this app.
2. **Move them to → `<column>`** — a `USelectMenu` of the remaining columns.

**One deletion is always refused:** the **last column of any `kind`**. If no `done` column exists,
`create_task(status='completed')` has nothing to resolve to and `search_tasks(status='completed')`
silently returns nothing — the compat seam above would break. Renaming is always available instead
("Done" → "Shipped" is free, since code reads `kind`).

**Also in scope:** the 8 remaining `<USelect>` in `tasks.vue` become `<USelectMenu>`. It is the only
file in the app still on plain `USelect`; every other project dropdown already migrated.

## Column color

Each column carries a **`color`**, used two ways: as a tint on the column itself on the board, and
as the color of that task's **status badge everywhere else in the app**. Today
`app/pages/projects/[slug].vue:107` hardcodes exactly this mapping:

```ts
const statusColor: Record<string, 'neutral' | 'primary' | 'success' | 'error'> = {
  todo: 'neutral', in_progress: 'primary', completed: 'success', blocked: 'error'
}
```

That map is **deleted** and replaced by the column's own color, so renaming or recoloring a column
propagates to every badge without a code change. Any other surface that renders a task status badge
resolves it the same way.

**`color` is one of the app's semantic aliases** — `primary | secondary | success | info | warning |
error | neutral` — not a hex value and not a raw Tailwind palette name. Two reasons, both binding:

1. The project rule is semantic tokens only (`.claude/rules/web-vue-ui.md`); the theme maps
   `primary → gold`, `secondary`/`info` → thunder, `neutral` → panel, so an alias keeps working when
   the theme changes and a hex does not.
2. `UBadge`'s `color` prop already takes exactly this set, so a badge is `:color="column.color"` with
   no translation layer.

> **The trap this must avoid.** Column color arrives as *data*, so the obvious implementation is a
> constructed class — `` :class="`bg-${column.color}-500/10`" ``. **That silently renders nothing.**
> Tailwind's scanner is static: it only emits classes it can see literally in source, and an
> interpolated name is invisible to it, so the utility is purged from the build. Cycle 56's plan
> review caught this exact pattern before it shipped.
>
> The column tint must therefore come from a **static lookup map with literal class strings** —
> `const TINT: Record<ColumnColor, string> = { primary: 'bg-primary/5', success: 'bg-success/5', … }` —
> so every class appears verbatim in the source the scanner reads. Badges are unaffected (`UBadge`
> takes the alias as a prop value, not a class), but the board tint is exactly the shape that breaks.

Seeded columns keep today's colors: Todo `neutral`, In Progress `primary`, Completed `success`,
Blocked `error` — the same four values that map is using now, so no badge changes appearance on
deploy.

## Migration

Seed exactly the four columns the board shows today, in today's order, all `is_default`:

| name | kind | color | position |
|---|---|---|---|
| Todo | `open` | `neutral` | 0 |
| In Progress | `started` | `primary` | 1 |
| Completed | `done` | `success` | 2 |
| Blocked | `blocked` | `error` | 3 |

Then backfill `tasks.column_id` from each task's current `status`. **Nothing visibly changes on
deploy** — same columns, same order, same cards. The feature is what you can do afterwards.

## Live reactivity

Column mutations publish on the existing bus. `ResourceName` is **singular** and the client dispatch
registry (`app/utils/live-dispatch.ts`) is keyed by that union, so a new resource that isn't wired up
is a type error. Adding a `taskColumn` member requires a dispatch entry; alternatively columns
publish `task`, which already invalidates the board and Home. The plan must pick one deliberately and
say why — not discover it at typecheck time.

## Testing

- **Pure:** the status↔kind mapping, both directions, including an unknown/absent default (which must
  fail loudly, not silently pick a column).
- **DB:** create/rename/reorder/delete columns; delete-with-cards down both branches (cards
  soft-deleted vs. reassigned); the last-column-of-a-kind refusal; `completedAtFor` stamping on a
  *custom* `done` column, not just one named "Completed".
- **Contract regression — the load-bearing one:** `create_task(status='todo')` and
  `search_tasks(status='in_progress')` behave identically before and after the migration, and
  `agent/context.ts` still returns the same open tasks. If this suite is weak, an agent integration
  breaks silently and nobody notices for days.
- **Color, and this one is easy to fake:** asserting a column renders *a* background class proves
  nothing — a purged class still leaves the element in the DOM. The browser check must read the
  **computed** background of a tinted column and confirm it is not transparent, and confirm a status
  badge elsewhere in the app changes color after that column is recoloured.
- **Browser (`playwright-cli`, never the MCP):** drag a card between columns; drag to reorder within a
  column and confirm it *sticks* (the snap-back trap); add, rename, reorder and delete a column down
  both delete branches.

## Out of scope

- **Per-project column sets.** Considered and rejected: ~20 projects to seed and maintain, tasks with
  no project need a default board, and moving a task between projects would have to reconcile two
  column sets. Revisit only if the global set proves too coarse.
- **Card content/density and filtering/saved filters/grouping** — cycle 59.
- **Subtasks, recurring tasks, reminders, calendar view** — still deferred (`docs/BACKLOG.md`).

## Risks

**The MCP contract is the real risk, not the schema.** Your agent sessions write tasks continuously
and would fail quietly — a `create_task` that 500s mid-session looks like an agent problem, not a
board problem. The mapping must be exercised by tests that would fail if it regressed, and the
staged check after deploy is a real `create_task`/`search_tasks` round-trip against prod, not a page
load.

**`is_default` is an invariant, not a hint.** Exactly one column per kind must carry it. Deleting,
reordering, or renaming must never leave a kind without one — that is what the last-column refusal
protects, and it deserves a DB-level partial unique index (`unique (kind) where is_default`), not
just application-level care.

**Triage writes to this board.** Cycle 57's `applyTask` calls `createTask({ status })`. It goes
through the same compat seam as everything else, so it needs no change — but it means a regression
here surfaces as captures silently failing to file, which is exactly the failure mode cycle 57 was
built to eliminate.
