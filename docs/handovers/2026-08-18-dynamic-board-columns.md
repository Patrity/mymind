---
title: Dynamic board columns — user-defined kanban lists with fixed semantics (cycle 58)
cycle: 58
date: 2026-08-18
status: >
  BUILT, NOT MERGED. All 11 tasks complete on `feat/dynamic-board-columns`, subagent-driven,
  per-task two-verdict review. **Every one of the 10 build tasks (1–10) came back review-clean on
  the first pass — zero fix rounds this cycle.** Five cross-task "important" findings were caught
  and routed forward via ledger + plan amendments instead (Task 1→4, Task 4→5, Task 4→6, Task 6→10,
  Task 7→9), all landed. Gates measured fresh at HEAD for this handover: **typecheck 0 errors /
  test 1204 passed (157 files) / test:db 144 passed (16 files) / build clean.** Merge/deploy
  authorization was **NOT granted** for this cycle (the plan says so explicitly) — the final
  migration is irreversible in practice (`tasks.status` is dropped) and Tony has not signed off.
  Not pushed, not deployed, no migration applied anywhere but local dev.
branch: feat/dynamic-board-columns
spec: ../superpowers/specs/2026-08-17-dynamic-board-columns-design.md
plan: ../superpowers/plans/2026-08-17-dynamic-board-columns.md
docs:
  - ../wiki/tasks-projects.md (board/status sections fully rewritten — mirrored to MyMind at /projects/mymind/wiki/tasks-projects.md, new document)
  - ../wiki/mcp.md (status-param semantics section added — mirrored to MyMind at /projects/mymind/wiki/mcp.md, adopted + relocated from a stale pre-existing mirror at /projects/mymind/wiki-mcp-server-agent-tools.md)
  - ../superpowers/plans/00-roadmap.md (cycle 58 row added)
tasks:
  - a1575210 (MyMind) — "New backlog column on tasks" — closed: subsumed, columns are now user-defined data
  - 7be76abc (MyMind) — "All project select dropdowns should be uselectmenu" — closed: the 8 remaining were all in tasks.vue, all swapped
---

# Dynamic board columns (cycle 58)

Columns become data you manage — add, rename, recolour, reorder, delete — while the *meaning* code
depends on (`kind`: `open | started | done | blocked`) stays fixed. `TaskStatus` (the old
`todo|in_progress|completed|blocked` vocabulary) survives everywhere it was ever accepted — every
MCP tool, every task API route, the agent's live context — but it is now a **resolved alias**, not
a stored value. Full architecture, the compat mapping, colour, delete rules, and drag mechanics are
in [`../wiki/tasks-projects.md`](../wiki/tasks-projects.md); this document is about how the cycle
went.

## Read this first: five things this cycle found, all consequential

The task brief for this documentation pass specifically asked that these be prominent.

**1. The migration could not be used as drizzle-kit generated it.** `pnpm db:generate` emits DDL
only — it has no idea `tasks.column_id` needs to go in nullable, get backfilled from every
existing row's `status`, and *only then* be tightened to `NOT NULL` + FK. Generated as-is (an
immediate `NOT NULL` column with no default on a non-empty `tasks` table), the migration fails
against every existing row the instant it runs. Task 1's brief called this out explicitly and
prescribed the exact hand-edited order (`CREATE TABLE task_columns` → seed rows → `ALTER TABLE
tasks ADD COLUMN column_id uuid` nullable → `UPDATE ... SET column_id = ...` backfill → `ALTER
COLUMN column_id SET NOT NULL` → add the FK), and the implementer verified the applied migration
matched that order and that the four seeded columns' post-migration task counts matched the
pre-migration board exactly (4/3/1/0 before = after).

**2. The FK is `ON DELETE NO ACTION`, and Postgres enforces it against soft-deleted rows too —
not in the plan at all.** `tasks.deleted_at` is invisible to a foreign key constraint. Task 3's
implementer discovered mid-task that a card soft-deleted *before* a column delete, or one
soft-deleted as *part of* the same `deleteColumn()` call, still carries a live `column_id` pointing
at the column about to be dropped — and `DELETE FROM task_columns` throws a raw FK violation the
moment any row, live or dead, still references it. Neither `deleteColumn`'s two modes (`delete`,
`reassign`) is just "soft-delete or reassign the live cards a user sees" — both also have to
repoint **every stray reference**, including historical dead rows the UI never shows, to a sibling
column of the same kind before the `DELETE` can succeed. This is now in `server/services/task-columns.ts`
and documented in the wiki's Deleting a column section; the plan's pseudocode for `deleteColumn`
never mentioned it.

**3. `server/services/home.ts` filtered status in raw SQL strings — invisible to typecheck — and a
fifth consumer was missed by three separate tasks.** Home's timeline and active-tasks panel build
their queries with `db.execute(sql\`... status in ('in_progress','todo','blocked') ...\`)` — a
literal string, not a Drizzle column reference, so nothing about dropping `tasks.status` would ever
surface there as a compile error; it would just silently stop matching anything the day the column
went away. Task 6's brief called this out and it was converted correctly. What the brief (and Tasks
4, 5, and 6's own file lists) missed was `server/services/search.ts:82`, which did `meta: t.status`
in the global search / command-palette task results — a fifth raw consumer nobody's grep scope
included. It surfaced only because Task 6's reviewer swept wider than the brief asked. Task 10
converted it (Step 0, added specifically for this) and reviewer independently swept `scripts/`,
`.claude/`, and `*.sql` afterward to confirm nothing else was left. **Lesson for any future
shadow-column drop in this repo: the grep scope has to include `test/`, not just `server/ app/
shared/`** — Task 10's implementer swept `test/` on their own initiative (outside the brief) and
found two more raw readers there that would otherwise have been silent compile breaks at drop time.

**4. "Emit from a deep watch, not `onEnd`" was necessary but not sufficient — the binding shape
matters too.** This repo already knew the `onEnd` trap (`AssignmentChain.vue`'s existing comment,
predating this cycle). What Task 8 discovered is a second, subtler trap one level down:
`@vueuse/integrations/useSortable`'s internal `moveArrayElement` branches on `isRef(list)`. A `ref`
binding (`AssignmentChain.vue`, and this cycle's own column-reorder list `orderedColumns`) clones
the array, splices the detached copy, and reassigns the ref's `.value` **once** — a bare deep watch
fires once, on a settled array, and is correct. A **plain array living inside `reactive()`**
(`tasks.vue`'s per-column card lists, `columnsTasks`) is mutated **live, in two steps** —
Sortable's default `onUpdate` does a synchronous removal followed by a `nextTick`-deferred
re-insertion — so a bare deep watch fires **twice**, and reading state on the first fire diffs a
half-removed array. Confirmed live during browser validation: dragging a card to the top of its
column, past another task sharing its stored `order`, silently dropped the dragged card from what
persisted. The fix is a **macrotask defer** (`setTimeout(fn, 0)`, spec-guaranteed to run after every
currently-queued microtask/`nextTick`), not `await nextTick()`, which only waits for Vue's own
queue and can still land mid-mutation. Both call sites now carry an inline comment naming this
distinction (Task 11 Step 4b, this task) — see [`../wiki/tasks-projects.md`](../wiki/tasks-projects.md#drag-behaviour)
for the full writeup.

**5. Shadowing `tasks.status` instead of dropping it in Task 1 was a pre-flight escalation, and it
paid for itself.** The plan as originally written had Task 1 drop `status` outright, which would
have left typecheck red across Tasks 1–6 and thrown away the rollback path during the riskiest
stretch of the cycle (rewriting every status consumer onto a join). The pre-flight scan caught this
before Task 1 started and escalated it to Tony, who ruled: **shadow** the column instead — Task 1
adds `column_id` and backfills it but leaves `status` in place; every service dual-writes both
through Task 9; Task 10 (a new task the amendment added, turning 10 tasks into 11) drops `status`
only once every consumer reads columns. The payoff: **every one of the 10 build tasks had a green
gate and was independently reviewable** — nothing was ever "the schema's half-migrated, tests are
red until three tasks from now, trust me." And the dual-write held true the entire way: Task 10's
drift query (`select count(*) from tasks t join task_columns c ... where t.status <>
<case-mapped kind>`) — the last moment such a check was even possible — returned **0**. The shadow
never diverged from the column across the whole cycle.

## What shipped

New `task_columns` table (`server/db/schema/task-columns.ts`): `id`, `name` (user-facing, never
read by code), `kind` (`open|started|done|blocked`, DB `CHECK`-constrained + `z.enum`-validated at
the API), `color` (one of `primary|secondary|success|info|warning|error|neutral`), `position`,
`is_default` (exactly one `true` row per kind, enforced by a partial unique index). `tasks.status`
is gone — replaced by `tasks.column_id` (FK, `NOT NULL`, indexed). Every pre-existing surface
(`create_task`/`edit_task`/`search_tasks`, all three task API routes, `agent/context.ts`) keeps
accepting/returning the old four-value `status` vocabulary unchanged; it now resolves through
`server/lib/tasks/status-kind.ts` (pure, throws on anything unrecognised) to the *default column of
the matching kind* on write, and filters/derives on the joined column's `kind` on read.
`completedAtFor` stamps on transition into any `kind='done'` column, not the literal string
`'completed'`. Column colour drives both the board tint (`app/pages/tasks.vue`'s `TINT` — a static
literal-class lookup map, deliberately not an interpolated Tailwind class, which the scanner would
silently purge) and every status badge app-wide (`app/pages/projects/[slug].vue` deleted its
hardcoded `statusColor` switch and reads the column instead). Deleting a column always requires a
choice for its cards (soft-delete or reassign to another column) and always refuses on the last
column of a kind, with the refusal rendered inline as a 409. The board's drag rewrote onto
`@vueuse/integrations/useSortable` (cards cross columns via a shared Sortable group; columns
reorder by dragging their header) replacing the old native HTML5 drag; all 8 remaining `<USelect>`
in `tasks.vue` — the last page in the app still on the plain component — became `<USelectMenu>`.
Full detail: [`tasks-projects.md`](../wiki/tasks-projects.md).

**Migration state, unambiguous:** three migrations landed — `0034` (table + seed + backfill),
`0035` (the `kind` CHECK constraint), `0036` (drop `tasks.status` + its index). All three have run
against local dev only. **This branch is not merged, not pushed, and not deployed** — the plan
withheld merge/deploy authorization explicitly, because migration `0036` is irreversible in
practice (there is no `tasks.status` to roll back to once it's gone) and Tony authorized cycle 57's
merge+deploy explicitly but has not authorized this one.

## The review loop — what it actually caught

Ten build tasks, subagent-driven, per-task two-verdict review. In commit order:

**Pre-flight (before Task 1) — one escalation, resolved by Tony before any code was written.** See
finding 5 above. The plan was amended in `0aaa54e` from 10 tasks to 11 (58 steps).

**Task 1 (schema + migration) — clean.** Migration order verified against the applied SQL; seed
colours cross-checked against `projects/[slug].vue:107`'s then-current hardcoded map so no badge
would regress on deploy; the shadow rule held (`status` and `tasks_status_idx` untouched); counts
4/3/1/0 identical before and after. One tracked-not-blocking item: `server/services/tasks.ts`
carried a temporary `STATUS_TO_KIND` + `resolveDefaultColumnId` stopgap, forced by `column_id`
being `NOT NULL` with no default while nothing yet read it properly — a second copy of the
status↔kind mapping, explicitly marked for Task 4 to delete, with a grep acceptance check added to
the plan (`34a29fa`) so "delete this" couldn't quietly survive.

**Task 2 (pure status↔kind mapping) — clean, zero findings.** Throw-don't-default verified as real
runtime code, not a type-level illusion; the prescribed non-vacuity check (make `kindForStatus`
return `'open'` unconditionally; the round-trip test must fail) confirmed the test suite actually
exercises the mapping.

**Task 3 (column service) — clean.** This is where finding 2 above (the FK enforced against
soft-deleted rows) was discovered and handled in both `deleteColumn` modes. Non-vacuity check:
disabling the last-of-kind refusal guard flips exactly one test from pass to fail (16/17 vs
17/17) — the guard is load-bearing, not decorative. Four seeded columns verified byte-identical
before/after every run, across an isolated file, the vacuity check, and the full `pnpm test:db`
gate — zero leaked fixtures.

**Task 4 (tasks service on columns) — clean.** The Task-1 stopgap's deletion was verified by
`grep -n "STATUS_TO_KIND\|resolveDefaultColumnId" server/services/tasks.ts` returning nothing.
Dual-write proven load-bearing (not just present) by a test that corrupts `tasks.status` via raw
SQL and asserts reads still come from the column join. Two important findings surfaced here and
were **routed forward via ledger + plan amendment rather than fixed in-loop**: `listTasksSummary`/
`countTasks`/`toTaskSummaryDTO` and `listTasks`'s status filter still read `tasks.status` directly
with no join (accurate today only via the dual-write, and a guaranteed compile error the moment
Task 10 dropped the column) → routed to Task 6; `task_columns.kind` was unconstrained text while
`toDTO` already called the throwing `statusForKind` on every live read → routed to Task 5.

**Task 5 (API routes + the `kind` CHECK constraint) — clean.** The CHECK constraint retroactively
broke Task 3's own DB tests, which had relied on `kind` being unconstrained text for cheap synthetic
per-test isolation — caught and fixed **in-scope, within Task 5 itself** (every fixture switched to
a real kind; the "last of kind" test now asserts directly against the seeded `blocked` default,
since every real kind already had one). No regressions; 17/17 stayed green. One minor was carried
forward and, as this documentation pass discovered, **quietly fixed anyway**: `POST`/`PATCH
/api/task-columns` answered a 500 (bare `Body.parse`) rather than a 400 on invalid input, flagged
to "carry to Task 9 or final review." `git diff 6107269 01ff681` shows both routes switched to
`safeParse` + a proper 400 as part of Task 9's own commit — never called out in Task 9's ledger
entry, but verifiably done. Not carried forward in this handover's deferred list because it's
already fixed.

**Task 6 (compat regression suite) — clean, zero findings.** The reviewer independently classified
all 12 new tests as differentiating-vs-happy-path and confirmed a 6/6 RED split against the
pre-fix consumers exactly matched the report's named failures — corruption tested in **both**
directions (a value outside the old whitelist AND inside it), which catches a "fails safe to a
stale reference" bug a one-directional test would miss. This is where finding 3 above (the
`search.ts` fifth consumer) surfaced, routed forward to Task 10.

**Task 7 (board renders columns + colour tint) — clean.** The Tailwind-purge trap was proven with a
controlled probe, not asserted from memory: the reviewer independently grepped every literal colour
token used elsewhere in the app and confirmed only `bg-neutral/5` had zero other occurrences —
meaning three of the four seeded colours would have *looked* fine under the broken interpolated
pattern purely by coincidence, and only a newly-picked colour (or a full sweep) would have exposed
it. Two findings routed forward: the project-dashboard badge's *label* still read raw `task.status`
even though its *colour* now came from the column (renaming "Completed"→"Shipped" would produce a
correctly-recoloured badge that still said "completed") → routed to Task 9; `useColumnList()` isn't
SSE-wired, so column mutations need an explicit `refetch()` → routed to Task 9.

**Task 8 (`useSortable` drag) — clean.** This is finding 4 above — the `isRef` branch discovery,
verified by the reviewer directly against the installed `vueuse` + `sortablejs` source, confirming
`AssignmentChain.vue` was never latently buggy. Routed to this task (Task 11, Step 4b): document
the distinction at both call sites.

**Task 9 (column management UI + `USelectMenu` swap) — clean.** `kind` immutability enforced at
both layers (the form doesn't offer it in edit mode, and the PATCH schema has no `kind` key at all,
so Zod strips one if sent). Every column mutation verified to call `refetch()` explicitly
(create/update/delete/reorder). A mid-task self-caught fix: the column-reorder `useSortable` call
was initially missing `watchElement: true`, so it silently never attached (the board container
doesn't exist until the loading skeleton resolves) — the reviewer confirmed Task 8's card sortables
already had this and that hole didn't also exist there.

**Task 10 (drop `tasks.status`) — clean. The irreversible step.** Step 0 (added by the Task 6→10
routing) converted `search.ts` first. The drift query — comparing every live task's shadow `status`
against its column's `kind`-derived equivalent, the last moment such a check was even possible —
returned **0**: the dual-write never diverged across the whole cycle. The implementer swept `test/`
for raw readers too, outside the brief's stated grep scope, and found two more that would have been
silent compile breaks; the reviewer independently swept `scripts/`, `.claude/`, and `*.sql` and
found nothing further live. The corruption tests from Task 6 were **removed of necessity, not
regression**: with the column gone, the column-join is the only type-permitted read path left, so
the compiler now enforces statically what those tests enforced at runtime. Every named substantive
assertion (overdue, done-exclusion, the "Completed:" timeline prefix, `openTasks`,
`buildLiveContext`) was confirmed intact in the diff.

## Gate numbers (measured this task, at HEAD)

```
pnpm typecheck   → 0 errors
pnpm test        → 1204 passed, 157 test files, 0 failed
pnpm test:db     → 144 passed, 16 test files, 0 failed   (real Postgres — dev DB)
pnpm build       → clean, exit 0 ("✨ Build complete!")
```

All four measured directly for this handover, not copied from the ledger — the task brief for this
documentation pass required that. `pnpm test:db` is not part of the CI/deploy gate (no Postgres in
CI, MyMind task `70bcc740`, still open) but is the gate every `*.db.test.ts` file in this cycle
actually runs under locally.

## Deferred minors carried forward (not fixed this cycle)

Everything the ledger flagged as deferred, for whoever does a whole-branch review before merge.
None of these are correctness bugs in shipped, reachable behaviour — they're test-quality gaps,
architectural preferences, or accepted residuals, each already triaged during its own task's
review. Two Task-1 items and one Task-5 item that the ledger originally flagged are **excluded**
below because they're no longer live concerns — noted separately underneath.

1. Column service (`server/services/task-columns.ts`): `deleteColumn`'s **delete**-mode stray
   repoint picks an unordered `siblings[0]` rather than `defaultColumnFor(col.kind)` (already
   available in the same file). `restoreTask` is a live undo path, so a task restored after its
   column was deleted lands in a non-deterministic same-kind column (Task 3).
2. The **reassign**-mode stray repoint (same function) has no test that would fail without it —
   its delete-mode twin does (Task 3).
3. `reorderColumns` is N sequential `UPDATE`s with no transaction; `createColumn`'s
   `max(position)+insert` is a non-atomic read-then-write. Single-user scale, awareness only
   (Task 3).
4. Circular import: `server/services/tasks.ts` ↔ `server/services/task-columns.ts` (`tasks.ts`
   imports `defaultColumnFor`; `task-columns.ts` imports `deleteTask`). Verified safe under ESM
   (no top-level call), but a real bidirectional coupling — a future module-level call in either
   file would break it (Task 4).
5. `test/task-columns.db.test.ts`'s header comment is stale — it still claims `kind` is
   unconstrained text for cheap per-test isolation, which Task 5's CHECK constraint made untrue
   (Task 4).
6. The last-of-kind refusal test now operates on the seeded `Blocked` row (structurally forced by
   the CHECK constraint, since every real kind already has a seeded default) — a regression in the
   refusal logic would delete a structural seed row rather than a disposable fixture (Task 5).
7. `server/services/tasks.ts`'s `activeTasks` three-kind filter is corruption-tested (raw-SQL
   shadow-column tamper, asserting the read still comes from the join) for the `started`/`done`
   kinds only — the `blocked` and `open` branches rely on code inspection of a literal `IN` list,
   not a differentiating test (Task 6).
8. Two `recentProjects` tests call `insertProject()` before their own `try` block, so a throw in
   the following setup call would leak the project row across test runs (Task 6).
9. `app/pages/projects/[slug].vue` gates its render on `tasksLoading` but not the columns query's
   own `isPending`, so a task badge can flash the neutral fallback colour before snapping to the
   column's real colour on a slow columns fetch (Task 7).
10. Six **real** (non-fixture) tasks' `order` values were rewritten from `0` to sequential
    integers during Task 8's live browser-validation debugging and left un-reverted. Relative sort
    order is unchanged (the query still falls back to `createdAt`), and this was disclosed
    candidly in the ledger at the time — but these are real production-shaped dev-DB rows, not
    test data (Task 8).
11. `persistTouchedColumns` (`app/pages/tasks.vue`) skips its trailing `refetch()` when a
    mid-loop `PATCH` fails — the `catch` branch toasts the error but the client can stay out of
    sync with the server until the next natural refetch. Matches the file's pre-existing error
    handling style elsewhere (Task 8).
12. A cleaner design would read the settled DOM order directly inside `onEnd` rather than diffing
    the Vue-side array via a watch at all, removing the microtask/macrotask timing dependency at
    its root. Not attempted this cycle — the shipped fix (macrotask defer) is correct but not the
    only possible design (Task 8).
13. Two independently-maintained static colour maps exist — `TINT` in `tasks.vue` (5%-opacity
    board wash) and `SWATCH` in `ColumnFormModal.vue` (solid picker fill). Justified (they're
    genuinely different shapes; `TINT` isn't exported), and TypeScript catches the two color *sets*
    drifting apart (both are `Record<TaskColumnColor, …>`), but not a value-level mismatch between
    them, and a shared module would make the relationship structural rather than by convention
    (Task 9).
14. `DeleteColumnModal`'s error alert isn't cleared when the user switches between delete/reassign
    mode after hitting a 409 — the stale refusal text stays visible next to the now-relevant
    reassign UI until the next confirm attempt (which does clear it before re-requesting) (Task 9).
15. `app/pages/tasks.vue` is now 883 lines carrying card drag-and-drop, column drag-and-drop,
    column CRUD, and task CRUD in one file. Worth a decomposition pass if another feature lands
    here (Task 9).
16. A renamed test in `test/tasks-columns.db.test.ts` claims to prove `getTask` re-derives status
    on a fresh read, but nothing actually changes between the create and the reread in that test,
    so it cannot distinguish "re-derived" from "cached." Labelling issue — the underlying property
    (derivation, not storage) is covered elsewhere (Task 10).
17. `server/services/search.ts` inlines the same task-select-with-kind shape that
    `server/services/tasks.ts` names `TASK_SELECT_WITH_KIND` (not exported), rather than sharing it
    (Task 10).

**Excluded from the list above — no longer live:**
- Two Task-1 deferred items (`resolveDefaultColumnId`'s extra DB round-trip per `createTask`; no
  direct test of its `columnId` population) both concerned the temporary stopgap Task 4 deleted
  outright (`grep -n "STATUS_TO_KIND\|resolveDefaultColumnId" server/services/tasks.ts` returns
  nothing at HEAD) — the code they were about no longer exists.
- One Task-5 deferred item (`POST`/`PATCH /api/task-columns` 500-on-invalid-input instead of 400)
  was verifiably fixed as part of Task 9's own commit (`git diff 6107269 01ff681` shows both routes
  switched from bare `Body.parse` to `safeParse` + `createError({ statusCode: 400, ... })`) — never
  narrated as such in Task 9's ledger entry, caught only by re-checking the code during this
  documentation pass.

## MyMind bookkeeping

- MyMind task `a1575210` ("New backlog column on tasks") — closed **completed**. Subsumed: the
  board no longer has a hardcoded four-column set, so adding a Backlog column (or any column) is
  now a UI action, not a code change.
- MyMind task `7be76abc` ("All project select dropdowns should be uselectmenu") — closed
  **completed**. The 8 remaining `USelect` instances were all in `app/pages/tasks.vue`; all 8 are
  now `USelectMenu`.
- Both wiki pages this cycle touched — [`tasks-projects.md`](../wiki/tasks-projects.md) and
  [`mcp.md`](../wiki/mcp.md) — mirrored to MyMind via `sync_document`. `tasks-projects.md` had
  never been mirrored before (no `mymind_id` in its frontmatter, and no prior document found under
  any path); it's now a new document at `/projects/mymind/wiki/tasks-projects.md`. `mcp.md`
  **did** already have a mirror, but not one its own frontmatter recorded — a stale copy from an
  earlier cycle existed at the old flat-naming convention path,
  `/projects/mymind/wiki-mcp-server-agent-tools.md` (last synced cycle 54, missing everything cycles
  48/50–53 added). Rather than fork a second copy at the new `/wiki/` convention path, this document
  was adopted by its existing MyMind id and relocated to `/projects/mymind/wiki/mcp.md` in the same
  `sync_document` call — one document, one history, now on the current path convention. Both
  `mymind_id`/`mymind_hash` pairs are written back into the local files' frontmatter.

## What to check before merging

- This branch has not been pushed, merged, or deployed. Migrations `0034`/`0035`/`0036` have only
  run against local dev.
- Merge/deploy authorization was **not granted** for this cycle — ask before merging. The final
  migration drops `tasks.status`, which is irreversible in practice (there's no column to roll
  back to once it's gone).
- The plan's own post-implementation verification steps (not part of the build, and not run by
  this task) still need to happen against prod **after** deploy, before assuming success:
  1. `select c.name, count(t.id) from task_columns c left join tasks t on t.column_id=c.id and
     t.deleted_at is null group by 1 order by min(c.position);` — counts must match the pre-deploy
     board.
  2. A real MCP round-trip: `create_task(status='todo')` then `search_tasks(status='todo')`
     against prod. This is the contract that breaks silently; a page load does not exercise it.
  3. Confirm capture triage (cycle 57) still files tasks — `applyTask` calls `createTask({status})`
     through this exact same compat seam.
- The 17 deferred minors above, plus the two moot/one-quietly-fixed items noted separately — none
  block a merge, but a whole-branch reviewer should see them named rather than discover them
  independently.
- `pnpm test:db`'s 144 tests are not wired into any deploy gate (MyMind task `70bcc740`, open since
  cycle 52) — `pnpm test` alone would stay green through a regression in any `*.db.test.ts` file,
  including every column/compat test this cycle added.
