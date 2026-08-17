# Dynamic Board Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make kanban columns user-defined data (name, colour, order) while the semantics code depends on stay fixed, without breaking a single existing MCP or API caller.

**Architecture:** A new `task_columns` table where each column carries a `kind` (`open|started|done|blocked`). `tasks.status` becomes `tasks.column_id`. Every existing surface keeps its four-value vocabulary, reinterpreted as a *kind* and resolved to that kind's default column — only the board itself learns columns exist. Drag moves to `useSortable`.

**Tech Stack:** Nuxt 4 (Nitro routes), Drizzle + Postgres, vitest, `@vueuse/integrations/useSortable`, `@tanstack/vue-query` + the cycle-21 live bus, Nuxt UI v4.

**Spec:** [`../specs/2026-08-17-dynamic-board-columns-design.md`](../specs/2026-08-17-dynamic-board-columns-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **`pnpm` only.** Gates: `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm build`. DB tests are excluded from `pnpm test` and run serially against one real Postgres — use per-run unique fixtures, `try/finally` cleanup, and leave no rows behind.
- **`kind` is what code reads. `name` is never read by code.** Any `switch`/comparison on a column's *name* is a defect.
- **The four-value vocabulary must keep working, unchanged, at every existing entry point.** `create_task(status='todo')` from a Claude Code session, `POST /api/tasks`, `PATCH`, `move`, `search_tasks(status=…)`. These resolve to the default column of the matching kind. **Never** remove or rename these params.
- **`color` is one of `primary | secondary | success | info | warning | error | neutral`** — never a hex value, never a raw Tailwind palette name (`blue-500`). Project rule: semantic tokens only (`.claude/rules/web-vue-ui.md`).
- **NEVER build a Tailwind class by interpolation** (`` `bg-${color}/10` ``). Tailwind's scanner is static and purges it; the element renders with no background and a naive "does the class exist" test still passes. Use a static lookup map with literal class strings.
- **Exactly one `is_default` column per kind.** Enforced by a partial unique index, not by application care.
- **`useSortable`: emit the reorder from a deep watch on the list, NOT from `onEnd`.** The `onEnd` race makes rows snap back. `app/components/settings/AssignmentChain.vue` is the working reference in this repo — read it before writing drag code.
- **Nuxt UI v4 only**, and **invoke the `nuxt-ui-docs` skill before writing component markup**. A previous cycle shipped a `UButtonGroup` that v4 renamed to `UFieldGroup` by skipping this.
- **Browser-validate with `playwright-cli`, never the Playwright MCP.** Invoke the `browser-testing` skill. Port 3000 is often held by another project on this machine — if you use another port, set `BETTER_AUTH_URL` to match or better-auth rejects login with "Invalid origin".
- **`publishChange({ resource, action, id })` after every successful mutation.** `ResourceName` is singular and `app/utils/live-dispatch.ts` is keyed by that union.
- **Singular/plural in user-facing copy must be explicit.** Never "1 tasks".
- `test/home-endpoint.db.test.ts` has a known intermittent ambient-state failure. It is not yours.
- **`tasks.status` is SHADOWED, not dropped, until Task 10.** Task 1 adds `column_id` and backfills
  it but leaves `status` in place; the services dual-write both during the cycle. Every task
  boundary therefore has green gates and is independently reviewable, and `status` stays a live
  safety net through the risky consumer rewrites. Task 10 drops it once every consumer reads
  columns. **Do not drop it early**, and do not "clean up" the dual-write before Task 10.

---

## File Structure

**New:**
- `server/db/schema/task-columns.ts` — the `task_columns` table.
- `shared/types/task-columns.ts` — `TaskColumnKind`, `TaskColumnColor`, `TaskColumnDTO`.
- `server/lib/tasks/status-kind.ts` — the pure status↔kind mapping. No I/O.
- `server/services/task-columns.ts` — column CRUD + delete-with-cards + default resolution.
- `server/api/task-columns/index.get.ts`, `index.post.ts`, `[id].patch.ts`, `[id].delete.ts`, `reorder.post.ts`
- `app/composables/useTaskColumns.ts`
- `app/components/tasks/ColumnHeader.vue`, `ColumnFormModal.vue`, `DeleteColumnModal.vue`
- Tests: `test/status-kind.test.ts` (pure), `test/task-columns.db.test.ts`, `test/tasks-compat.db.test.ts`

**Modified:**
- `server/db/schema/tasks.ts` — adds `column_id`; `status` shadowed until Task 10.
- `server/services/tasks.ts` — resolve status→column; `completedAtFor` keyed on kind.
- `server/lib/agent/tools.ts` (3 schemas), `server/lib/agent/context.ts`, `server/services/home.ts` (raw SQL).
- `server/api/tasks/index.post.ts`, `[id].patch.ts`, `[id]/move.post.ts`, `index.get.ts`
- `shared/types/tasks.ts`, `app/composables/useTasks.ts`
- `app/pages/tasks.vue` — columns from data, `useSortable`, tint, 8 × `USelect` → `USelectMenu`
- `app/pages/projects/[slug].vue` — delete the hardcoded `statusColor` map
- `docs/wiki/tasks-projects.md`, `docs/wiki/mcp.md`

---

## Task Sequence

| # | Task | Gate |
|---|---|---|
| 1 | Schema + migration (table, seed, backfill; `status` kept) | `pnpm test` + manual SQL read |
| 2 | Shared types + pure status↔kind mapping | `pnpm test` |
| 3 | Column service (CRUD, delete-with-cards, defaults) | `pnpm test:db` |
| 4 | Tasks service on columns | `pnpm test:db` |
| 5 | Task API routes + column API routes | `pnpm test:db` |
| 6 | **Compat regression suite** (MCP tools, context, Home) | `pnpm test:db` |
| 7 | Board renders columns from data + colour tint | browser |
| 8 | `useSortable` drag: cross-column + in-column reorder | browser |
| 9 | Column management UI + `USelectMenu` swap | browser |
| 10 | Final migration: drop `tasks.status` | `pnpm test:db` + manual SQL read |
| 11 | Wiki + handover + roadmap | — |

---

### Task 1: Schema + migration

**Files:**
- Create: `server/db/schema/task-columns.ts`
- Modify: `server/db/schema/tasks.ts`, `server/db/schema/index.ts`
- Modify: the generated migration (hand-add seed + backfill DML — see Step 4)

**Interfaces:**
- Consumes: nothing.
- Produces: `taskColumns` table object; `tasks.columnId`.

- [ ] **Step 1: Create the table**

```ts
// server/db/schema/task-columns.ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'

// A board column. `kind` is what CODE reads; `name` is user-facing and never switched on.
// `color` is one of the app's semantic aliases (primary|secondary|success|info|warning|error|
// neutral) — it feeds both the board tint and this task's status badge app-wide.
export const taskColumns = pgTable('task_columns', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  kind: text('kind').notNull(),              // open | started | done | blocked
  color: text('color').notNull().default('neutral'),
  position: integer('position').notNull().default(0),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => [
  index('task_columns_position_idx').on(t.position),
  // The compat seam resolves status -> "the default column of this kind". Exactly one per
  // kind, enforced here rather than in application code: if a kind ever loses its default,
  // create_task(status=...) has nothing to resolve to and fails at runtime.
  uniqueIndex('task_columns_one_default_per_kind').on(t.kind).where(sql`is_default`)
])

export type TaskColumn = typeof taskColumns.$inferSelect
```

- [ ] **Step 2: Swap `status` for `column_id` on tasks**

In `server/db/schema/tasks.ts`: **keep the `status` line exactly as it is**, add
`columnId: uuid('column_id').notNull().references(() => taskColumns.id)`, and **add**
`index('tasks_column_idx').on(t.columnId)` alongside the existing `tasks_status_idx` (do not
remove it).

`status` is shadowed through this cycle and dropped in Task 10 — see Global Constraints.

- [ ] **Step 3: Export from the barrel** — append `export * from './task-columns'` to `server/db/schema/index.ts`.

- [ ] **Step 4: Generate, then HAND-EDIT the migration**

Run: `pnpm db:generate`

drizzle-kit emits DDL only — it cannot know the seed rows or the backfill. **Open the generated file and rewrite it into this exact order**, or the `not null` FK fails against existing rows:

```sql
CREATE TABLE "task_columns" ( ... );                         -- as generated
CREATE UNIQUE INDEX "task_columns_one_default_per_kind" ON "task_columns" ("kind") WHERE is_default;
CREATE INDEX "task_columns_position_idx" ON "task_columns" ("position");

-- Seed today's board, in today's order, with today's badge colours.
INSERT INTO "task_columns" (name, kind, color, position, is_default) VALUES
  ('Todo',        'open',    'neutral', 0, true),
  ('In Progress', 'started', 'primary', 1, true),
  ('Completed',   'done',    'success', 2, true),
  ('Blocked',     'blocked', 'error',   3, true);

-- Add nullable, backfill, THEN enforce.
ALTER TABLE "tasks" ADD COLUMN "column_id" uuid;
UPDATE "tasks" t SET column_id = c.id FROM "task_columns" c
 WHERE (t.status = 'todo'        AND c.kind = 'open')
    OR (t.status = 'in_progress' AND c.kind = 'started')
    OR (t.status = 'completed'   AND c.kind = 'done')
    OR (t.status = 'blocked'     AND c.kind = 'blocked');
-- Anything with an unexpected status lands in the default open column rather than blocking
-- the migration.
UPDATE "tasks" SET column_id = (SELECT id FROM "task_columns" WHERE kind='open' AND is_default)
 WHERE column_id IS NULL;

ALTER TABLE "tasks" ALTER COLUMN "column_id" SET NOT NULL;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_column_id_fk"
  FOREIGN KEY ("column_id") REFERENCES "task_columns"("id");
CREATE INDEX "tasks_column_idx" ON "tasks" ("column_id");
-- NOTE: tasks.status and tasks_status_idx are deliberately LEFT IN PLACE. They are dropped in
-- Task 10, once every consumer reads columns. Dropping here would leave the branch red for six
-- tasks and throw away the rollback path during the riskiest part of the cycle.
```

- [ ] **Step 5: Apply and verify the data survived**

Run: `pnpm db:migrate`, then:

```sql
select c.name, c.kind, c.color, count(t.id)
from task_columns c left join tasks t on t.column_id = c.id and t.deleted_at is null
group by 1,2,3 order by c.position;
```

Expected: four rows, and the per-column counts match what the board showed before the migration. **If any count is zero where the board had cards, stop and report BLOCKED** — the backfill mapped wrongly and re-running will not fix already-migrated rows.

- [ ] **Step 6: Gates + commit**

Run: `pnpm typecheck && pnpm test`. **Both must be green.** Nothing yet reads `column_id`, and
`status` is untouched, so this task is purely additive — if anything is red, the schema change is
wrong, not merely incomplete. Commit:

```bash
git add server/db/ && git commit -m "feat(tasks): task_columns table; tasks.status -> column_id"
```

---

### Task 2: Shared types + pure status↔kind mapping

**Files:**
- Create: `shared/types/task-columns.ts`, `server/lib/tasks/status-kind.ts`
- Modify: `shared/types/tasks.ts`
- Test: `test/status-kind.test.ts`

**Interfaces:**
- Produces: `TaskColumnKind`, `TaskColumnColor`, `TaskColumnDTO`; `kindForStatus(s): TaskColumnKind`, `statusForKind(k): TaskStatus`, `TASK_COLUMN_COLORS`.

**Context:** `server/lib/tasks/status-kind.ts` is **pure** — no `server/db`, no services, no I/O. It is the hinge the whole compat seam turns on, so it must be testable without a database.

- [ ] **Step 1: Types**

```ts
// shared/types/task-columns.ts
export type TaskColumnKind = 'open' | 'started' | 'done' | 'blocked'

/** Semantic aliases only — matches UBadge's `color` prop. Never a hex or a palette name. */
export const TASK_COLUMN_COLORS = ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral'] as const
export type TaskColumnColor = typeof TASK_COLUMN_COLORS[number]

export interface TaskColumnDTO {
  id: string
  name: string
  kind: TaskColumnKind
  color: TaskColumnColor
  position: number
  isDefault: boolean
}
```

In `shared/types/tasks.ts` keep `TaskStatus` exactly as it is (it is now the *alias* vocabulary, not the storage) and add `columnId: string` to `TaskDTO` alongside the existing `status: TaskStatus`.

- [ ] **Step 2: Write the failing tests**

```ts
// test/status-kind.test.ts
import { describe, it, expect } from 'vitest'
import { kindForStatus, statusForKind } from '../server/lib/tasks/status-kind'

describe('status <-> kind', () => {
  it('maps every status to its kind', () => {
    expect(kindForStatus('todo')).toBe('open')
    expect(kindForStatus('in_progress')).toBe('started')
    expect(kindForStatus('completed')).toBe('done')
    expect(kindForStatus('blocked')).toBe('blocked')
  })

  it('maps every kind back to its canonical status', () => {
    expect(statusForKind('open')).toBe('todo')
    expect(statusForKind('started')).toBe('in_progress')
    expect(statusForKind('done')).toBe('completed')
    expect(statusForKind('blocked')).toBe('blocked')
  })

  // Round-tripping is what keeps an agent's create_task(status=X) readable as X later.
  it('round-trips every status', () => {
    for (const s of ['todo', 'in_progress', 'completed', 'blocked'] as const) {
      expect(statusForKind(kindForStatus(s))).toBe(s)
    }
  })

  // Fail loudly. A silent fallback here would file tasks into the wrong column forever.
  it('throws on an unknown status rather than guessing', () => {
    expect(() => kindForStatus('archived' as never)).toThrow()
    expect(() => statusForKind('nonsense' as never)).toThrow()
  })
})
```

- [ ] **Step 3: Run to verify failure** — `pnpm vitest run test/status-kind.test.ts`. Expected: module not found.

- [ ] **Step 4: Implement**

```ts
// server/lib/tasks/status-kind.ts
// PURE. The hinge of the compatibility seam: every pre-existing caller speaks TaskStatus,
// every column speaks TaskColumnKind. No I/O so it is testable without a database.
import type { TaskStatus } from '../../../shared/types/tasks'
import type { TaskColumnKind } from '../../../shared/types/task-columns'

const STATUS_TO_KIND: Record<TaskStatus, TaskColumnKind> = {
  todo: 'open', in_progress: 'started', completed: 'done', blocked: 'blocked'
}
const KIND_TO_STATUS: Record<TaskColumnKind, TaskStatus> = {
  open: 'todo', started: 'in_progress', done: 'completed', blocked: 'blocked'
}

export function kindForStatus(status: TaskStatus): TaskColumnKind {
  const k = STATUS_TO_KIND[status]
  // Throw rather than defaulting: a silent fallback would file tasks into the wrong column
  // indefinitely, and the caller (an MCP tool) can surface a real error to the agent.
  if (!k) throw new Error(`unknown task status: ${status}`)
  return k
}

export function statusForKind(kind: TaskColumnKind): TaskStatus {
  const s = KIND_TO_STATUS[kind]
  if (!s) throw new Error(`unknown column kind: ${kind}`)
  return s
}
```

- [ ] **Step 5: Verify GREEN, then prove non-vacuity** — make `kindForStatus` return `'open'` unconditionally; the mapping test must FAIL. Restore, confirm PASS. Report both outputs.

- [ ] **Step 6: Commit** — `git commit -m "feat(tasks): pure status<->kind mapping"`

---

### Task 3: Column service

**Files:**
- Create: `server/services/task-columns.ts`
- Test: `test/task-columns.db.test.ts`

**Interfaces produced:**
- `listColumns(): Promise<TaskColumnDTO[]>` (ordered by `position`)
- `defaultColumnFor(kind): Promise<TaskColumnDTO>` — throws if absent
- `createColumn({name, kind, color, position?}): Promise<TaskColumnDTO>`
- `updateColumn(id, {name?, color?}): Promise<TaskColumnDTO>`
- `reorderColumns(idsInOrder: string[]): Promise<void>`
- `deleteColumn(id, opts: { mode: 'delete' | 'reassign', targetColumnId?: string }): Promise<{ ok: boolean, reason?: string, affected: number }>`

**Binding rules:**
- `deleteColumn` **refuses** when the column is the last of its `kind` — return `{ ok: false, reason }`, never throw, never delete. The compat seam needs a default per kind to resolve to.
- `mode: 'delete'` **soft**-deletes the cards via `deleteTask` (`server/services/tasks.ts:177`, sets `deletedAt`) — never a raw `db.delete(tasks)`, which would skip its side effects.
- `mode: 'reassign'` requires `targetColumnId`; reject if absent or equal to the column being deleted.
- Every mutation publishes `publishChange({ resource: 'task', action: 'updated', id })` — see Task 5's note on why `task` and not a new resource.

- [ ] **Step 1: Write the failing DB tests** covering, at minimum: list is ordered by position; `defaultColumnFor` returns the seeded default and throws for a kind with none; create appends at the end; rename/recolour persists; reorder rewrites positions; **delete refuses the last column of a kind**; `mode:'delete'` soft-deletes the cards (assert via `getTask()`, which filters `deleted_at` — a raw `select` would pass even if nothing happened); `mode:'reassign'` moves every card to the target and deletes the column; reassign with a missing `targetColumnId` is refused.

- [ ] **Step 2: Run to verify failure** — `pnpm test:db -- test/task-columns.db.test.ts`.

- [ ] **Step 3: Implement.** The one piece worth spelling out is the refusal, because it is the invariant the whole compat seam rests on:

```ts
export async function deleteColumn(
  id: string, opts: { mode: 'delete' | 'reassign', targetColumnId?: string }
): Promise<{ ok: boolean, reason?: string, affected: number }> {
  const db = useDb()
  const [col] = await db.select().from(taskColumns).where(eq(taskColumns.id, id)).limit(1)
  if (!col) return { ok: false, reason: 'that column no longer exists', affected: 0 }

  // The last column of a kind can never be deleted, whatever happens to its cards: with no
  // `done` column, create_task(status='completed') has nothing to resolve to and
  // search_tasks(status='completed') silently returns nothing. Renaming is always available.
  const siblings = await db.select({ id: taskColumns.id }).from(taskColumns)
    .where(and(eq(taskColumns.kind, col.kind), ne(taskColumns.id, id)))
  if (siblings.length === 0) {
    return { ok: false, reason: `“${col.name}” is the only ${col.kind} column — rename it instead of deleting it`, affected: 0 }
  }
  // ... mode handling, then delete the column row
}
```

- [ ] **Step 4: Verify GREEN.**

- [ ] **Step 5: Prove non-vacuity** — remove the `siblings.length === 0` guard; the last-of-kind test must FAIL. Restore. Report output.

- [ ] **Step 6: Commit.**

---

### Task 4: Tasks service on columns

**Files:** Modify `server/services/tasks.ts`. Test: extend `test/task-columns.db.test.ts` or add `test/tasks-columns.db.test.ts`.

**Interfaces:** `createTask` / `updateTask` keep accepting `status?: TaskStatus` **and** gain `columnId?: string`. `TaskDTO` carries both `columnId` and a derived `status` (from the column's kind, via `statusForKind`) so every existing consumer keeps reading `.status`.

**Dual-write, deliberately.** Every write that sets `column_id` must ALSO write the matching
`tasks.status` (`statusForKind(column.kind)`). The column is shadowed until Task 10, and the point
of shadowing is that it stays a truthful rollback target — a stale `status` would make the safety
net a lie. Reads should already prefer the column join; the shadow write exists for rollback, not
for reading.

- [ ] **Step 1: Failing tests** — `createTask({status:'todo'})` lands in the default open column; `createTask({columnId})` honours the explicit column; `columnId` wins if both are passed; `updateTask({status:'completed'})` moves the card to the default done column **and stamps `completedAt`**; moving into a *custom* column whose kind is `done` also stamps `completedAt` (this is the whole point — assert against a column you create named something else); moving out of a done column clears `completedAt`; `toDTO` returns a `status` derived from the column's kind.

- [ ] **Step 2: Verify failure. Step 3: Implement.**

`completedAtFor` changes signature from `(status, now)` to `(kind, now)`:

```ts
/** Returns `now` when transitioning into ANY done-kind column, null otherwise. */
export function completedAtFor(kind: TaskColumnKind, now: Date): Date | null {
  return kind === 'done' ? now : null
}
```

Resolution helper used by create/update: if `columnId` is given use it; else if `status` is given, `defaultColumnFor(kindForStatus(status))`; else `defaultColumnFor('open')`.

- [ ] **Step 4: GREEN. Step 5: Commit.**

---

### Task 5: API routes

**Files:** Modify `server/api/tasks/index.post.ts`, `[id].patch.ts`, `[id]/move.post.ts`, `index.get.ts`. Create `server/api/task-columns/{index.get,index.post,reorder.post}.ts`, `server/api/task-columns/[id].{patch,delete}.ts`.

- [ ] **Step 1:** In all three task routes, **keep** `status: z.enum(['todo','in_progress','completed','blocked']).optional()` exactly as it is and **add** `columnId: z.string().uuid().optional()`. Removing or renaming `status` breaks every existing caller.
- [ ] **Step 2:** `GET /api/tasks` gains an optional `columnId` filter; the existing `status` filter now maps through `kindForStatus` and filters on the joined kind.
- [ ] **Step 3:** Column routes are thin wrappers over Task 3's service. `DELETE` takes `{ mode, targetColumnId? }` in the body and returns the service's `{ ok, reason, affected }` — a refusal is a 409 with `reason` as `statusMessage`, not a 500.
- [ ] **Step 4: Live bus.** Column mutations publish `{ resource: 'task', … }` rather than adding a `taskColumn` member to `ResourceName`. Rationale to put in the code comment: `task` already invalidates the board and the Home panel, which is the entire audience for a column change; adding a union member would require a matching `live-dispatch.ts` entry (it is a type error otherwise) for no additional reach. **If a future surface needs column-only invalidation, add the member then.**
- [ ] **Step 5:** Gates + commit.

---

### Task 6: Compat regression suite

**Files:** Modify `server/lib/agent/tools.ts` (3 schemas), `server/lib/agent/context.ts`, `server/services/home.ts`. Create `test/tasks-compat.db.test.ts`.

**This is the highest-risk task in the cycle.** Your Claude Code sessions call these tools continuously; a break here looks like an agent problem, not a board problem, and could go unnoticed for days.

- [ ] **Step 1: Write the regression tests FIRST**, before touching the consumers. They must assert behaviour that is *identical to today*:
  - `create_task(status:'todo')` → task readable with `status === 'todo'`.
  - `create_task(status:'completed')` → `completedAt` stamped.
  - `search_tasks(status:'in_progress')` returns exactly the started-kind tasks — **including one sitting in a custom column you created with `kind:'started'` and a different name.** That single assertion is the difference between the feature working and the feature being cosmetic.
  - `edit_task(status:'blocked')` moves the card to the default blocked column.
  - `agent/context.ts`'s open-task query returns the same tasks as before (open + started kinds).
  - Home's active-tasks query returns open/started/blocked and excludes done; `overdue` is true only for a past due date in a non-done column.
- [ ] **Step 2:** Run them — they will fail against the un-updated consumers.
- [ ] **Step 3:** Update the consumers. **`server/services/home.ts` is the trap:** its status filters are raw SQL strings (`status in ('in_progress','todo','blocked')`, `status <> 'completed'`), so a stale reference there will NOT surface as a typecheck error. Grep the file for `status` and convert each to a join on `task_columns.kind`.
- [ ] **Step 4:** GREEN. **Step 5:** `pnpm typecheck && pnpm test && pnpm test:db`. **Step 6:** Commit.

---

### Task 7: Board renders columns from data + colour tint

**Files:** Modify `app/pages/tasks.vue`. Create `app/composables/useTaskColumns.ts`. Modify `app/pages/projects/[slug].vue`.

- [ ] **Step 1:** `useTaskColumns()` following the conventions in `app/composables/useTasks.ts`.
- [ ] **Step 2:** Replace the hardcoded `COLUMNS` array in `tasks.vue` with the fetched columns, ordered by `position`. Cards group by `columnId`, not `status`.
- [ ] **Step 3: The tint — this is the step that silently fails if done the obvious way.**

```ts
// Static map: every class string appears LITERALLY so Tailwind's scanner emits it.
// Never `bg-${column.color}/5` — the scanner cannot see an interpolated name, purges the
// utility, and the column renders with no background while a class-presence test still passes.
const TINT: Record<TaskColumnColor, string> = {
  primary: 'bg-primary/5', secondary: 'bg-secondary/5', success: 'bg-success/5',
  info: 'bg-info/5', warning: 'bg-warning/5', error: 'bg-error/5', neutral: 'bg-elevated'
}
```

- [ ] **Step 4:** In `app/pages/projects/[slug].vue`, **delete** the `statusColor` map (line ~107) and read the colour from the task's column instead. Any other status badge in the app resolves the same way.
- [ ] **Step 5: Browser-validate.** Invoke `browser-testing`. Confirm the board renders the four seeded columns in order with cards in the right ones. **Then read the COMPUTED background of a tinted column** (`getComputedStyle(el).backgroundColor`) and assert it is not `rgba(0, 0, 0, 0)` — a purged class leaves the element in the DOM and would pass a class-presence check. Screenshot and read it.
- [ ] **Step 6:** Commit.

---

### Task 8: `useSortable` drag

**Files:** Modify `app/pages/tasks.vue`.

**Read `app/components/settings/AssignmentChain.vue` first** — it is this repo's working `useSortable` implementation, including the watch-not-`onEnd` pattern and a comment explaining why.

- [ ] **Step 1:** Replace the native HTML5 drag handlers with `useSortable` per column, sharing a group so cards move between columns.
- [ ] **Step 2:** Cross-column drop → `PATCH` the card's `columnId`. Within-column drop → persist the new `order` for the affected column.
- [ ] **Step 3: The trap.** Emit from a **deep watch on the list**, not from `onEnd`. `onEnd` fires before the model settles and the row snaps back to its original position. `AssignmentChain.vue:9-10` documents this.
- [ ] **Step 4: Browser-validate** — drag a card to another column and confirm it *stays* after a reload; drag a card up within a column and confirm the new order *persists* after a reload. A drag that looks right but reverts on refresh is the exact failure this step exists to catch. Screenshot.
- [ ] **Step 5:** Commit.

---

### Task 9: Column management UI + `USelectMenu` swap

**Files:** Create `app/components/tasks/{ColumnHeader,ColumnFormModal,DeleteColumnModal}.vue`. Modify `app/pages/tasks.vue`.

**Invoke the `nuxt-ui-docs` skill before writing any markup.**

- [ ] **Step 1:** Column header with an actions menu: Rename, Change colour, Delete. Add-column control at the end of the board.
- [ ] **Step 2:** `ColumnFormModal` — name input + colour picker over `TASK_COLUMN_COLORS` (render each swatch from the same static `TINT`/badge map; no interpolated classes). `kind` is chosen on create and **not editable afterwards** — changing it would silently reclassify every card in the column.
- [ ] **Step 3:** `DeleteColumnModal` — states the card count with explicit singular/plural ("1 task", "3 tasks"), offers **Delete the tasks** or **Move them to →** (`USelectMenu` of remaining columns). Disable the confirm until a target is chosen in reassign mode. A 409 refusal (last of kind) renders its `reason` inline rather than as a generic error.
- [ ] **Step 4:** Swap the 8 `<USelect>` in `tasks.vue` for `<USelectMenu>`.
- [ ] **Step 5: Browser-validate** — add a column, rename it, recolour it and confirm a task badge elsewhere in the app changes colour, reorder it by dragging the header, then delete it down **both** branches (cards deleted; cards reassigned). Attempt to delete the last `done` column and confirm the inline refusal. Screenshot.
- [ ] **Step 6:** Commit.

---

### Task 10: Final migration — drop `tasks.status`

**Files:** Modify `server/db/schema/tasks.ts`; new generated migration; remove the dual-write from `server/services/tasks.ts`.

**Do this only when Tasks 1-9 are complete and green.** Until now `status` has been a shadow copy
and a rollback target; this is the point of no return.

- [ ] **Step 1: Prove nothing reads it.** `grep -rn "tasks.status\|\.status" server/ app/ shared/ --include='*.ts' --include='*.vue' | grep -v node_modules` and account for every hit. Hits on a `TaskDTO.status` field are fine (it is derived from the column's kind). A hit that reads or writes the DB column is a Task 4-6 gap — **fix it before proceeding, do not drop around it.**
- [ ] **Step 2: Verify the shadow agreed with the column right up to the end** — this is the last moment the check is possible:

```sql
select count(*) from tasks t join task_columns c on c.id = t.column_id
where t.deleted_at is null and t.status <> case c.kind
  when 'open' then 'todo' when 'started' then 'in_progress'
  when 'done' then 'completed' else 'blocked' end;
```

Expected: **0**. Any non-zero means the dual-write drifted and some consumer wrote one side only — stop and report BLOCKED with the offending rows.

- [ ] **Step 3:** Remove `status` from `server/db/schema/tasks.ts` and its `tasks_status_idx`, remove the dual-write from the services, then `pnpm db:generate`. Read the generated SQL: it must contain only the index drop and the column drop.
- [ ] **Step 4:** `pnpm db:migrate`, then `pnpm typecheck && pnpm test && pnpm test:db && pnpm build`. All green.
- [ ] **Step 5:** Commit.

---

### Task 11: Wiki + handover + roadmap

- [ ] **Step 1:** Rewrite the board/status sections of `docs/wiki/tasks-projects.md`: the column model, `kind` semantics, the compat mapping, colour, and the delete rules. State plainly that `TaskStatus` is now an **alias vocabulary**, not storage.
- [ ] **Step 2:** Update `docs/wiki/mcp.md` — the task tools' `status` param still works and what it now means.
- [ ] **Step 3:** Mirror every changed wiki page to MyMind via `sync_document`, writing the returned `mymind_id`/`mymind_hash` back into each file's frontmatter. Check existing frontmatter first so you update rather than fork.
- [ ] **Step 4:** Write `docs/handovers/2026-08-XX-dynamic-board-columns.md` with accurate frontmatter, the gate numbers **you measure yourself**, what the review loop caught, and every deferred item.
- [ ] **Step 5:** Add the cycle 58 row to `docs/superpowers/plans/00-roadmap.md`.
- [ ] **Step 6:** Close MyMind tasks `a1575210` (blocked/subsumed → completed) and `7be76abc`. Commit.

---

## Post-implementation verification (NOT part of the build)

The migration is irreversible in practice — `tasks.status` is dropped. After deploy, verify against prod before assuming success:

1. `select c.name, count(t.id) from task_columns c left join tasks t on t.column_id=c.id and t.deleted_at is null group by 1 order by min(c.position);` — counts must match the pre-deploy board.
2. A real MCP round-trip: `create_task(status='todo')` then `search_tasks(status='todo')` against prod. This is the contract that breaks silently; a page load does not exercise it.
3. Confirm capture triage still files tasks — cycle 57's `applyTask` calls `createTask({status})` through this same seam.
