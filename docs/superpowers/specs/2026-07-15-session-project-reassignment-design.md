---
title: Session ↔ Project reassignment + path-based auto-routing
date: 2026-07-15
status: draft
supersedes: []
related:
  - docs/handovers/2026-06-16-project-association-foundation.md
  - docs/superpowers/specs/2026-06-16-project-association-foundation-design.md
  - server/services/projects.ts
  - server/services/sessions.ts
  - server/assets/setup/cc-hook.sh
---

# Session ↔ Project reassignment + path-based auto-routing

## Problem

Sessions are auto-associated to a canonical project at ingest, but a growing
bucket lands in **`uncategorized`** and there is **no way to reassign them**.
The trigger: sessions from a new work PC (`Tony-NLS`) keep coming back
unassigned.

### Evidence (prod, 2026-07-15)

`uncategorized` holds 31 sessions (30 with no git remote) plus one genuinely
`NULL`-project row. The real composition:

| Pattern | Example `cwd` | Why it misses today |
|---|---|---|
| **Non-git deep subfolders** (the bulk; all `Tony-NLS`) | `/mnt/c/Users/tonyc/Documents/Projects/Terawulf/MTO/Takeoffs/Piping` | No remote. `basename(cwd)` is a leaf (`Piping`), matches nothing; no `Terawulf` project exists. The project root is **4 levels up**. |
| **Stale-but-matchable** | `/Users/tony/Documents/GitHub/finances` | `basename` = `finances` **would** match the existing `finances` project now — these rows predate the matching logic. |
| **Git subfolder** | `/Users/tony/Documents/GitHub/rogue-racer/itch_assets` | `basename` = `itch_assets` misses; the repo **root** basename `rogue-racer` is a project, but we never look at it. |
| **Genuinely no project** | `/Users/tony`, `/tmp`, `/Users/tony/Documents/GitHub` | Bare home/scratch. `uncategorized` is *correct*; a `tony`/`tmp` project would be junk. |

**Root cause:** `findOrCreateProject`'s no-remote branch only matches an existing
project by the cwd **basename** (slug/alias), else drops to `uncategorized`. It
never uses the full path, never looks at the git repo root, and never learns
from a correction. `hostname`/`machineId` play no part in resolution, so
"`Tony-NLS`" is a correlation, not a cause — that machine's paths simply don't
match existing projects.

## Goals

1. **Reassign** any session to a different project — one at a time (session
   detail) and in bulk (sessions list), including **creating a project inline**.
2. Reassignment **cascades to the session's agent-scoped memories** (they inherit
   the session's project; keep them consistent).
3. **Stop the recurrence**: no-remote sessions route by **full-path prefix**
   against known project roots; the first Claude run in a fresh no-remote folder
   **auto-creates** a project named after that folder and registers its path, so
   all descendants prefix-match it (no `MTO`/`_shared` children).
4. **Cheap ingest wins**: match on the **git repo-root basename**; one-time
   **re-resolve** of the existing `uncategorized` backlog against *existing*
   projects.
5. Everything stays **live** (`publishChange`) per the live-data convention.
6. **Surface the machine name** (`hostname`) on the sessions list and detail
   views — machine is the strongest triage signal ("these are all `Tony-NLS`"),
   so it belongs where you reassign.

## Non-goals

- No MCP tool for reassignment (possible follow-up; UI/API only here).
- No change to how *remote-bearing* sessions resolve (that path already works).
- The backfill does **not** auto-create projects (that would mint `Piping` from a
  leaf). Terawulf-style buckets are drained by a manual reassign + inline create,
  once.
- No host/machine-based routing.

## Design

### 1. Data model — new `path_prefixes` column

Add to `projects` (migration):

```
path_prefixes text[] not null default '{}'::text[]
```

These are the **routing roots** for no-remote sessions. Kept **separate from the
existing `local_paths`** on purpose: `local_paths` passively accumulates *every*
observed cwd via `findOrCreateProject`'s `touch()` (an accidental `/Users/tony`
session already leaked into `2d-rpg`'s `local_paths`). Routing on `local_paths`
would send every home-dir session to `2d-rpg`. `path_prefixes` is written only at
**auto-create** and by **explicit reassignment**. `local_paths` stays
informational.

Prefixes are stored as absolute paths with no trailing slash. A cwd `C` matches a
prefix `P` iff `C === P` or `C` starts with `P + '/'`. **Longest matching prefix
wins.**

### 2. Ingestion resolver — `findOrCreateProject` no-remote branch

New order (the git-remote branch is unchanged):

1. **Prefix match**: longest `path_prefixes` entry across all projects that is an
   ancestor-or-equal of `cwd` → `touch()` + return.
2. **Label match** (existing `matchProjectByLabel`): `basename(cwd)` by
   slug/alias. **Extended**: also try the **git repo-root basename** when the hook
   provides it (`git_root`), so `rogue-racer/itch_assets` → `rogue-racer`.
3. **Auto-create** (new) — only if `isAutoCreatable(cwd)` (see stoplist):
   create a project `name = basename(cwd)`, unique slug, seed
   `path_prefixes = [cwd]`, `local_paths = [cwd]`. Descendants then hit step 1.
4. **Uncategorized**: stoplisted cwd, or no cwd at all.

`touch()` is unchanged (still appends cwd to `local_paths`, bumps
`last_activity_at`).

#### Stoplist — `isAutoCreatable(cwd): boolean`

Returns `false` (→ `uncategorized`) when the cwd is bare/scratch. Default rules
(a code constant, tunable):

- **Home roots** (regex): `^/(Users|home)/[^/]+/?$`, `^/mnt/[a-z]/Users/[^/]+/?$`.
- **Temp**: `/tmp`, `/private/tmp`, `/var/tmp`, or under `/tmp/`.
- **Generic leaf names** (case-insensitive `basename`): `documents`, `github`,
  `downloads`, `desktop`, `src`, `projects`, `code`, `repos`, `dev`, `tmp`,
  `temp`.

Worked examples:

```
/Users/tony                         -> home root      -> uncategorized
/tmp                                -> temp           -> uncategorized
/Users/tony/Documents/GitHub        -> leaf 'github'  -> uncategorized
/mnt/c/Users/tonyc/Documents/Projects/Terawulf -> create 'Terawulf', prefix=[cwd]
/mnt/c/.../Terawulf/MTO/Piping (later) -> prefix match -> Terawulf
```

### 3. Hook change — send the git root

`server/assets/setup/cc-hook.sh` already sends `cwd` and `git_remote`. Add:

```
gr_root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)"
# payload: "git_root": <gr_root or null>
```

Accept `git_root` in `server/api/hooks/cc/[event].post.ts` (Zod `nullish`) and
thread it to `upsertSession` → `findOrCreateProject` for the step-2 repo-root
basename match. Old hooks that don't send it degrade gracefully (field optional).

> Note: the hook is a self-updating asset (`curl .../api/setup/cc-hook`), but
> existing installs won't re-pull automatically. The git-root match is a
> best-effort enhancement; the prefix + auto-create logic works without it.

### 4. Reassignment — service, API, UI

**Service** `reassignSession(id, { projectSlug, pathPrefix? })` in
`server/services/sessions.ts`:

1. Resolve target project by slug (404 if missing).
2. In a transaction:
   - `sessions.set({ project: slug, projectId })` where `id`.
   - **Cascade**: `memories.set({ project: slug, projectId })` where
     `session_id = id AND scope = 'agent'`.
   - If `pathPrefix`: append to the project's `path_prefixes` (dedup).
3. `publishChange`: `session` updated (`id`); `project` updated for **both** the
   old and new slug (dashboard counts move). The memory cascade emits no per-row
   `memory` events — the existing project-rename cascade emits nothing at all, so
   this is already an improvement; the exact memory-list live-refresh wiring is a
   plan detail. (`session`, `project`, `memory` are all valid `ResourceName`s.)

**Bulk** `reassignSessions(ids, { projectSlug, pathPrefix? })` — same, looped in
one transaction; emits per session id.

**API**
- `PATCH /api/sessions/[id]` — body `{ project: string, pathPrefix?: string }`.
- `POST /api/sessions/reassign` — body `{ ids: string[], project: string, pathPrefix?: string }`.
- Inline project creation reuses the existing `POST /api/projects` then reassigns
  (two calls from the UI; no new atomic create-and-assign endpoint).

**UI**
- **Session detail** (`app/pages/sessions/[id].vue`): replace the read-only
  `ProjectBadge` with a Nuxt UI project selector (`USelectMenu`, create-inline
  option). On change, optional "Also route future sessions under `<folder>`"
  toggle with an editable prefix pre-filled from `cwd` (trimmable to the root).
- **Sessions list** (`app/pages/sessions/index.vue`): multi-select rows →
  "Move to project" action (same selector + optional prefix) to drain the 31.
- Reads via `@tanstack/vue-query`; writes via `useMutation` calling the endpoints
  (per `add-live-resource` / live-data rule). No hand-rolled refetch.

Fixing a mis-auto-created project (e.g. first run landed in `MTO`): reassign its
sessions to the right project, register the correct prefix, then **Merge** the
junk project away (existing Phase-3 feature).

### 5. Backfill — one-time re-resolve

Script (or a guarded block reusing `scripts/backfill-projects.ts`) that walks all
`uncategorized` / `NULL` sessions and re-resolves against **existing** projects
only: prefix match → label match → git-root basename. **Never auto-creates.**
Applies the memory cascade for any session it moves. Idempotent. Self-heals
`finances`/`rogue-racer`; Terawulf-style buckets stay until manually reassigned.

### 6. Surface the machine name (`hostname`)

`sessions.hostname` is populated (e.g. `Tony-NLS`, `MacBook-Pro`) but the read
views don't expose it, and the detail page currently shows the opaque
`machineId` UUID instead. Machine is the strongest visual signal for triage, so
surface it where reassignment happens.

- **Types/services**: add `hostname: string | null` to `SessionListItem` (so
  `SessionMeta` inherits it); select `sessions.hostname` in `listSessions` and
  return it from `getSessionMeta`.
- **Sessions list** (`app/pages/sessions/index.vue`): show the hostname per row
  (monitor icon + name) in the stats line, and add a **hostname filter**
  (`USelect`, distinct-hostname items) alongside the existing source/project
  filters — the fast path to "filter to `Tony-NLS` → select all → Move to
  project".
- **Session detail** (`app/pages/sessions/[id].vue`): show `hostname` on the
  machine line (monitor icon); demote `machineId` to a tooltip/secondary, or
  fall back to it when `hostname` is null.

No schema or ingest change — the column already exists and the hook already
sends `hostname`.

## Edge cases

- **cwd with spaces** (`.../BOM Schedules`): paths are stored/compared verbatim;
  prefix match is a plain string op — safe.
- **Prefix collisions**: two projects whose prefixes are ancestor/descendant of
  each other → longest wins (deterministic).
- **Reassign to `uncategorized`**: allowed (manual un-file); does not register a
  prefix.
- **Trailing slashes**: normalize prefixes (strip trailing `/`) on write.
- **The lone `NULL`-project row** (has a `2d-rpg` remote but never resolved): the
  backfill's git-remote path re-resolves it to `2d-rpg`.
- **Auto-create race** (two fresh sessions same folder): unique-slug retry +
  re-select, mirroring the existing `git_remote_key` race handling.

## Testing

- **Pure/unit**: `isAutoCreatable` (each stoplist rule + the Terawulf pass-case);
  longest-prefix match selection; prefix normalization.
- **Service**: `findOrCreateProject` no-remote — prefix hit, label hit, git-root
  hit, auto-create, stoplist→uncategorized; `reassignSession` cascade to
  agent-memories + prefix registration + live emits (old & new project).
- **Ingestion integration**: two events under the same tree resolve to one
  auto-created project (second via prefix, no second project).
- **Browser** (`playwright-cli`, per browser-testing skill): reassign a single
  session on the detail page; bulk-move from the list; assert the badge/counts
  update live and the DB rows (session + memories) moved. Assert the `hostname`
  renders on both list rows and the detail page, and that the hostname filter
  narrows the list to a single machine.

## Rollout

1. Migration: add `path_prefixes`.
2. Ship resolver + hook + reassignment API/UI.
3. Deploy; re-pull hook on active machines (or accept graceful degrade).
4. Run the re-resolve backfill against prod (drains stale matchable rows).
5. Manually reassign + inline-create `Terawulf` (register prefix
   `.../Projects/Terawulf`) — validates the loop and drains the largest cluster.

## Open questions

None — resolved during brainstorm (recurrence mechanism = prefix + auto-create;
memories cascade = yes; stoplist = small configurable default).
