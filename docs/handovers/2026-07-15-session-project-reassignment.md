---
title: Session ↔ Project reassignment + path-based auto-routing
cycle: 46
date: 2026-07-15
status: BUILT + browser-validated on branch feat/session-project-reassignment — gates green (typecheck 0 / test 773 / build). Final whole-branch review + merge/deploy PENDING (Tony).
branch: feat/session-project-reassignment (built subagent-driven, 8 tasks; controller ran full playwright-cli E2E for tasks 6 and 8)
docs:
  - ../wiki/sessions.md (living reference — resolver order, hostname filter, reassignment; cycle bumped 24→46)
  - ../wiki/projects.md (living reference — path_prefixes field; cycle bumped 27→46)
  - ../superpowers/specs/2026-07-15-session-project-reassignment-design.md (spec)
  - ../superpowers/plans/2026-07-15-session-project-reassignment.md (plan)
  - ../superpowers/plans/00-roadmap.md (cycle-46 row)
related:
  - ../handovers/2026-06-16-project-association-foundation.md
  - ../superpowers/specs/2026-06-16-project-association-foundation-design.md
problem: >
  Cycle 23's git-remote resolver left a structural gap: sessions with no git remote (scratch
  folders, non-git projects, one-off scripts) could only resolve by an existing cwd/git-root
  label match, else fell into the seeded `uncategorized` bucket — permanently, with no way for a
  human to move them out except direct SQL. Tony's dev DB accumulated hundreds of uncategorized
  sessions this way (largest cluster: a `Tony-NLS` / Terawulf machine with no registered project).
  There was also no UI to reassign a session's project at all, single or bulk, and no signal in
  the sessions list to tell WHICH machine a session came from when triaging the backlog.
keydecision: >
  Two new routing roots, kept deliberately distinct: `local_paths` (passive history, every cwd
  ever observed, exact-match only) vs the new `path_prefixes` (routing roots, ancestor-matched,
  used to auto-route FUTURE sessions). The no-git-remote resolver order is prefix → label → 
  auto-create[stoplisted] → uncategorized; auto-create seeds `path_prefixes` with the triggering
  cwd so the SAME folder never needs to auto-create (or fall to uncategorized) again. Manual
  reassignment can also register a prefix, which is how a human teaches the router. Reassignment
  cascades to `scope='agent'` memories (never `user`/`world`, which stay project-agnostic) because
  an agent memory's project association is defined BY its source session.
---

# Cycle 46 — Session ↔ Project reassignment + path-based auto-routing

## What shipped

### 1. `path_prefixes` column (migration `0027_bumpy_virginia_dare.sql`)
`projects.path_prefixes text[] NOT NULL DEFAULT '{}'` — routing roots, added to `ProjectDTO.pathPrefixes`. Distinct from the pre-existing `local_paths` (passively accumulated, exact-match, never used for routing).

### 2. Resolver — `findOrCreateProject` (`server/services/projects.ts`)
The no-git-remote branch (git-remote branch is **unchanged**) now runs, in order:
1. **Longest `path_prefixes` match** — `longestPrefixMatch(cwd, candidates)` picks the candidate whose registered prefix is the longest ancestor-or-equal of `cwd`.
2. **Label match** — `cwd` basename, then `gitRoot` basename, against existing `slug`/`aliases` (`matchProjectByLabel` — match-only, never creates).
3. **Auto-create** — if `cwd` passes `isAutoCreatable`, create a project named for the `cwd` leaf, seeding `path_prefixes = [cwd]`.
4. **Uncategorized fallback** (unchanged since cycle 23).

Pure decision helpers live in `server/lib/projects/path-routing.ts` (`normalizePrefix`, `basenameOf`, `isUnderPrefix`, `longestPrefixMatch`, `isAutoCreatable`), unit-tested in `test/path-routing.test.ts`.

**Stoplist** (`isAutoCreatable`) refuses to auto-create from: home roots (`/Users/<x>`, `/home/<x>`, `/mnt/<d>/Users/<x>`), temp dirs (`/tmp`, `/private/tmp`, `/var/tmp` + descendants), and generic leaf names (`documents`, `github`, `downloads`, `desktop`, `src`, `projects`, `code`, `repos`, `dev`, `tmp`, `temp`). These fall through to Uncategorized.

### 3. `git_root` threading
`cc-hook.sh` now sends `git_root` (`git rev-parse --show-toplevel`); the `[event]` hook route accepts it (`UpsertSessionInput.gitRoot`); threaded into `findOrCreateProject` as a transient label-match candidate — **never persisted** as its own session column.

### 4. Reassignment (single + bulk)
`reassignSession(id, { projectSlug, pathPrefix? })` / `reassignSessions(ids, { projectSlug, pathPrefix? })` (`server/services/sessions.ts`), each in one `db.transaction`:
- `applyReassign` sets `sessions.project`/`project_id` and **cascades every `scope='agent'` memory for that session** onto the new project (`user`/`world` memories are untouched — they're global by design).
- `registerPrefix` (optional) appends a `normalizePrefix`-ed path onto the target project's `path_prefixes` (deduped) — the mechanism by which a manual move teaches the router.

Endpoints: `PATCH /api/sessions/[id]` `{project, pathPrefix?}`, `POST /api/sessions/reassign` `{ids, project, pathPrefix?}`. Both emit `publishChange` for `session` (each id), `project` (old slug(s) + new slug, deduped), and `memory` (each id). Composable: `useSessions().reassign` / `.reassignMany`.

### 5. Reassignment UI
`app/components/sessions/ReassignProjectModal.vue` — shared modal, used from:
- the session **detail** page (`Move` button, single session), and
- the sessions **list** page (per-row checkbox multi-select → "Move to project" bar, bulk).

`USelectMenu` project picker + a `'__create__'` sentinel ("➕ Create new project…") that inline-creates via `useProjects().create` before reassigning. An optional "Auto-route future sessions here" toggle (shown only when a `cwd` is known) pre-fills the prefix from the session's `cwd` and, when checked, passes `pathPrefix`. Client-safe `normalizePrefix` copied into `app/utils/path-routing.ts` (do not import the server module from a component).

### 6. Hostname surfacing + filter
`hostname` added to `SessionListItem` (`SessionMeta` inherits it via the same select). Sessions **list**: per-row hostname + a hostname filter. **Detail**: hostname in the header, `machineId` demoted to a tooltip.

### 7. Re-resolve backfill
`scripts/reresolve-uncategorized.ts` — re-resolves `uncategorized`/`NULL` sessions against **existing** projects only (resolver order: git_remote key → longest path-prefix → cwd leaf-basename label). **Never auto-creates.** Cascades agent memories the same way `reassignSession` does. `--dry-run` supported. **Not yet run on prod.** Dry-run on dev: would move 14/399 sessions.

## Plan correction — found and fixed during browser E2E (`046ddc9`)

`ReassignProjectModal.vue` lives in `app/components/sessions/`, so Nuxt's auto-import registers it under the **dir-prefixed** name `SessionsReassignProjectModal`. Both pages referenced it by the bare tag `<ReassignProjectModal>`, which silently resolved to nothing — no console error, the modal component just never mounted. Fixed by adding an explicit import to both pages:

```ts
import ReassignProjectModal from '~/components/sessions/ReassignProjectModal.vue'
```

**Lesson for future plans/cycles:** a component that lives in `components/<subdir>/` and is referenced by its **bare** (non-prefixed) tag name must be explicitly imported — Nuxt's auto-import name for it is the prefixed form, not the bare one. This is now called out in the sessions wiki page as a durable gotcha.

## Verification

### Gates (this session, final tree, `feat/session-project-reassignment`)
- `pnpm test` → **773 passed** (117 files), 0 failed.
- `pnpm typecheck` → **0 errors**.
- `pnpm build` → succeeded, `.output/` produced, no warnings surfaced.

### Browser E2E (playwright-cli + authenticated fetch, controller-run on dev, prior to this task)
- Hostname surfacing + filter: PASS.
- Single `PATCH` reassign + bulk `POST /api/sessions/reassign`: PASS.
- Agent-memory cascade: PASS — **15 memories moved and restored** across the test.
- Path-prefix registration + `normalizePrefix`: PASS.
- Checkbox `@click.stop` (select a row without navigating to its detail page): PASS.
- reka-ui project picker renders all options including create-inline, **0 console errors**.
- Full UI reassignment flow (list bulk-move + detail single-move): PASS.
- **One Critical bug found and fixed** during this pass: the `046ddc9` auto-import fix above.

## Deferred / known issues

- **`findOrCreateProject` auto-create swallows non-race errors.** The `try/catch` around the auto-create insert only handles the expected unique-slug race (falls back to re-selecting the winner by prefix); any OTHER insert error also lands in that catch and silently degrades to a re-select-that-finds-nothing → falls through to Uncategorized, with **no log**. This is asymmetric with the git-remote branch (which distinguishes the race case explicitly). Plan-mandated behavior for this cycle; a targeted re-select-and-log is a reasonable follow-up.
- **Theoretical lost-update race on `path_prefixes`.** `reassignSession`/`reassignSessions` read the target project row **before** opening the transaction. Two concurrent reassignments to the same project, each registering a different prefix, could race (last transaction's `[...cur, prefix]` overwrites using a stale `cur`). Negligible for a single-user deployment; would need a `SELECT ... FOR UPDATE` or an atomic array-append to fully close.
- **Double `project` emit on same-project reassign.** A single reassignment to the SAME project the session already belongs to emits `publishChange({resource:'project', ...})` twice (once for "from", once for "to", both the same slug). Idempotent and harmless — just a wasted refetch.
- **`selectedIds` not pruned by filter.** On the sessions list, if a row is checkbox-selected and then a filter (source/project/hostname/search) hides it, it stays in `selectedIds` — a subsequent bulk move would silently include a session the user can no longer see in the list. Minor UX polish, not a data-safety issue (the id is still valid, just invisible).
- **Reassignment isn't durable for a still-active session.** Manual reassignment only updates the `sessions` row; it doesn't suppress future resolution. If the session gets another hook event (`Stop`/`SessionEnd` carrying `cwd`/`git_remote`), `upsertSession` re-runs `findOrCreateProject` and can overwrite the manual move — a git-remote session snaps back to its remote's project, and a no-git-remote session reassigned without registering a path prefix re-runs prefix → label → auto-create/uncategorized. Manual reassignment is intended for **ended** sessions (draining the historical backlog); for no-remote sessions it's made durable going forward by **registering a path prefix** on reassign (future events prefix-match to the same project). A "pin this session's project" flag that suppresses re-resolution entirely is a possible follow-up.

## Deploy / prod-drain steps (per the plan, post-merge)

1. `pnpm db:migrate` runs in CD — confirm `path_prefixes` exists on the prod `projects` table after deploy.
2. Re-pull the hook (`cc-hook.sh`) on active machines to start sending `git_root`; sessions from machines that haven't re-pulled degrade gracefully (no `git_root` → resolver just skips that label candidate).
3. Run `node_modules/.bin/tsx --env-file=.env scripts/reresolve-uncategorized.ts --dry-run` on prod, review the move list, then re-run without `--dry-run`.
4. In the UI: create a `Terawulf` project, bulk-move its sessions (the largest uncategorized cluster, machine `Tony-NLS`), and register the path prefix `…/Projects/Terawulf` on it — this both drains the biggest backlog cluster and validates auto-routing end-to-end for that machine's future sessions.

## Next steps for Tony

1. Review the branch; when ready, merge `feat/session-project-reassignment` to master.
2. Run the deploy/prod-drain steps above post-merge.
3. Optional follow-ups: fix the auto-create error-swallow (add a log), consider the `path_prefixes` race if concurrent reassignment ever becomes a real workflow, prune `selectedIds` on filter change.
