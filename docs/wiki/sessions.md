---
title: Sessions View
status: shipped
cycle: 46
updated: 2026-07-15
---

# Sessions View

Browse the Claude Code / Hermes session transcripts ingested by the hooks, with token + tool stats, assistant reasoning, and full tool-call detail. Capture fidelity was upgraded in **cycle 13 phase 2** (bridget parity).

## Ingestion (`server/services/sessions.ts` + `transcript-parse.ts`)

The hook (`POST /api/hooks/cc/[event]` for liveness/metadata, `POST /api/hooks/cc/transcript` for the JSONL delta) feeds `ingestTranscript`, which calls the pure `parseTranscriptLines`. Captured per message (first-class columns since phase 2):

- `content` (text blocks) + `thinking` (thinking blocks, kept separate), `model`, `stop_reason`, `request_id`, `parent_uuid`, `is_sidechain`, and the raw `usage` jsonb. Idempotent on `(session_id, external_uuid)` (synthetic uuid when a line has none).
- **`tool_events` table** (new): each `tool_use` block → a row (`tool_name`, `args`, `tool_use_id`, `caller_type`, `is_sidechain`, `phase='pre'`, `message_id` linked to the parent assistant message); the matching `tool_result` closes it (`result`, `exit_status` ok/error, `phase` completed/failed). Idempotent on `(session_id, tool_use_id)`. A **pure tool_result** user line produces no message row but still closes its event.
- **Session columns** (from the `[event]` hook): `machine_id`, `hostname`, `git_branch`, `git_commit`, `git_remote`, **`git_root`** (cycle 46 — `git rev-parse --show-toplevel`, sent by `cc-hook.sh`; used transiently as a label-match candidate, never persisted), `app_version`, plus `ended_at` (set on `SessionEnd`). **`project_id`** is resolved on ingest via `findOrCreateProject({ gitRemote, cwd, gitRoot })` — see the **resolver order** below. The legacy `project` slug is kept in sync. See [projects.md](projects.md).
- Aggregates recomputed from the real tables on each ingest: `message_count`, `tool_count` (from `tool_events`), `input_tokens`/`output_tokens` (SQL sum over the `usage` column), `started_at`/`last_active` (min/max message `created_at`).

Legacy `messages.metadata.{usage,model,tools,type}` is still dual-written so pre-phase-2 rows keep rendering. (Limitation: a `tool_use` and its `tool_result` are correlated within one ingest batch — they always ship together in a Stop-triggered delta, so this is not a practical gap.)

## API (`server/api/sessions/*`, types in `shared/types/session.ts`)
- `GET /api/sessions?source=&project=` → `SessionListItem[]` (incl. `hostname`), newest first.
- `GET /api/sessions/[id]` → meta only (`getSessionMeta`): session header (`cwd`, `machineId`, `hostname`, `gitBranch`/`gitCommit`/`gitRemote`, `appVersion`, `endedAt`, metadata, counts). No messages. Auth-gated.
- `GET /api/sessions/[id]/messages?since=<iso>` → `messages[]` (incl. `thinking`, `model`, `isSidechain`) + **`toolEvents[]`** (`SessionToolEventDTO`); `?since=` returns only messages after that timestamp for incremental append.
- `PATCH /api/sessions/[id]` `{ project, pathPrefix? }` — single-session reassignment. See **Reassignment** below.
- `POST /api/sessions/reassign` `{ ids, project, pathPrefix? }` — bulk reassignment.

## UI (`app/pages/sessions/{index,[id]}.vue`)
- **List**: cards with source badge, project, **hostname** (machine that recorded the session), title/summary, message/tool/token stats, relative last-active; source/project/**hostname** filters + search. Per-row checkbox multi-select (`@click.stop` — selecting doesn't navigate) drives a **"Move to project"** bulk-action bar.
- **Detail**: header now shows git `branch @ commit`, hostname (machine ID demoted to a tooltip), and app version (from the first-class columns). A **Move** button opens the reassignment modal for this one session. Transcript turns: user/assistant via sanitized `MdView`; assistant turns show a `model` label and a collapsible **thinking…** block; sidechain (subagent) turns are dimmed (`opacity-70`). Tool turns render real **tool events** — name + exit-status badge + args/result JSON — falling back to the legacy `metadata.tools` badges for old rows. Per-message metadata collapsible retained.

## Validated (2026-06-15)
A crafted transcript (thinking + Bash tool_use + tool_result + SessionEnd w/ git/machine) ingested via the hooks → detail shows `thinking`, model, the Bash event (completed/ok, args+result, message-linked), git branch/commit, machine, and `endedAt`; re-ingest is idempotent (counts steady). Gates: typecheck 0 / test 267 / build.

## Summaries + search (cycle 13 phase 4, shipped 2026-06-16)
- **Summarization** — `summarize-sessions` task (`*/5`, `server/services/session-summarize.ts`): selects new/stale/grown sessions (real-message floor 6, refresh-delta 50, stale 24h; mirrors bridget `sess_summarize`), builds a transcript (text + `<thinking>` + tool one-liners, head/tail elide at 60k chars), `chat('reasoning')` → strict-JSON `{title, summary}`, writes `title` (COALESCE — never clobbers an existing title), `summary`, and a `title‖summary` `summary_embedding`. State + retry tracked in `sess_summary_state`. Validated: 203 sessions summarized, 100% ok.
- **Search** — `searchSessions`/`searchMessages` (`server/services/session-search.ts`): hybrid trigram (`ilike`/`similarity` on title+summary / content) + vector (`summary_embedding` / `messages.embedding`, `<=>` halfvec cosine, try/catch trigram-only fallback), RRF-fused (`rrfFuse`). Wired into `searchAll` + the command palette (`AppSearch.client.vue`) as **Sessions** + **Messages** groups (message hits deep-link to the parent session). `messages.embedding` backfilled by the `embed-messages` task (`*/4`).

## Cycle-24 changes (Sessions UX)

### Progressive detail loading
`GET /api/sessions/[id]` now returns **meta only** (`getSessionMeta` — header, counts, git info, no messages). The transcript is fetched separately via `GET /api/sessions/[id]/messages` (`getSessionMessages`), which accepts a `?since=<iso>` query parameter for incremental append (returns only messages created after that timestamp).

### Resizable split-pane detail layout
The detail page uses `UDashboardPanel resizable` to render a two-column split: metadata (left panel) and transcript (right panel). Panel widths are adjustable by the user.

### Virtualized + live-tailing transcript
`app/components/sessions/SessionTranscript.vue` virtualizes the message list using `@vueuse/core` `useVirtualList` (only visible rows are mounted). It **autoscrolls / live-tails**: a watcher on `meta.messageCount` fetches `?since=` deltas and appends them to the local list. When the viewport is scrolled up, a **"↓ N new"** button appears (count from `countNewSince`); clicking it jumps to bottom and resumes tailing. Pure scroll helpers live in `app/utils/transcript-scroll.ts` (`isAtBottom`, `countNewSince`).

### List live-activity pulse (cycle 24 final)
The sessions list now shows a small **pinging dot** (`bg-primary animate-ping`) next to the title of any row whose `lastActive` timestamp just increased. The dot disappears after 2 seconds. This is purely client-side: a `watch` on the `sessions` computed compares each row's `lastActive` against a `Map` of previously-seen values; on advance it sets `pulse[id] = Date.now()` and schedules a delete via `setTimeout`. The underlying list already refetches automatically on SSE `session` events (live-dispatch invalidates `['session','list']`), so counts and timestamps stay current without any additional polling.

## Cycle 46 — reassignment + path-based auto-routing + hostname

### Ingest resolver order (no-git-remote sessions)
`findOrCreateProject({ gitRemote, cwd, gitRoot })` (`server/services/projects.ts`) resolves a session's project. With a git remote, the remote-key branch is unchanged (match `git_remote_key`/`aliases`, else race-safe create). **Without** a git remote, the order is:
1. **Longest registered `path_prefixes` match** — the candidate project whose registered prefix is the longest ancestor-or-equal of `cwd` wins (`longestPrefixMatch`, `server/lib/projects/path-routing.ts`).
2. **Label match** — `cwd` basename, then (if no `cwd` hit) `gitRoot` basename, matched against existing `slug`/`aliases` (`matchProjectByLabel`; match-only, never creates).
3. **Auto-create** — if the `cwd` passes `isAutoCreatable` (see stoplist below), create a new project named for the `cwd` leaf folder, seeding `path_prefixes = [cwd]` so every future session under that folder resolves instantly via step 1.
4. **Uncategorized fallback** — the seeded bucket, unchanged from cycle 23.

`path_prefixes text[]` (migration `0027_bumpy_virginia_dare.sql`) is the routing-roots column — distinct from the passively-accumulated `local_paths` (every observed `cwd`, never used for routing). See [projects.md](projects.md#path_prefixes-routing-roots).

**Stoplist** (`isAutoCreatable`, `server/lib/projects/path-routing.ts`) refuses to auto-create from bare/scratch cwds: home roots (`/Users/<x>`, `/home/<x>`, `/mnt/<d>/Users/<x>`), temp dirs (`/tmp`, `/private/tmp`, `/var/tmp` + descendants), and generic leaf names (`documents`, `github`, `downloads`, `desktop`, `src`, `projects`, `code`, `repos`, `dev`, `tmp`, `temp`). These fall through to Uncategorized instead. Pure helpers (`normalizePrefix`, `basenameOf`, `isUnderPrefix`, `longestPrefixMatch`, `isAutoCreatable`) are unit-tested in `test/path-routing.test.ts`.

`git_root` (`git rev-parse --show-toplevel`, sent by `cc-hook.sh` on the `[event]` hook) is a **transient** label-match candidate only — it is never persisted as a session column beyond the label check.

### Hostname surfacing + filter
`hostname` was added to `SessionListItem` (so `SessionMeta` inherits it via the same select). The sessions **list** shows it per row and offers a hostname filter (narrows to sessions from one machine — useful when several machines route to the same "Uncategorized" bucket before prefixes are learned); the **detail** page shows it in the header, demoting the raw `machineId` to a tooltip.

### Reassignment (single + bulk)
`reassignSession(id, { projectSlug, pathPrefix? })` / `reassignSessions(ids, { projectSlug, pathPrefix? })` (`server/services/sessions.ts`), each in one `db.transaction`:
1. **`applyReassign`** — sets `sessions.project`/`project_id`, and **cascades every `scope='agent'` memory for that session** (`memories.sessionId` match) onto the new project. `user`/`world`-scope memories are untouched (they're already project-agnostic).
2. **`registerPrefix`** (optional) — if the caller passes a `pathPrefix`, it's `normalizePrefix`-ed and appended to the target project's `path_prefixes` (deduped) — this is how a manual reassignment **teaches** the router: future sessions under that path auto-route to this project via step 1 of the resolver, without ever hitting auto-create or Uncategorized again.

Endpoints: `PATCH /api/sessions/[id]` `{project, pathPrefix?}` and `POST /api/sessions/reassign` `{ids, project, pathPrefix?}`. Both emit `publishChange` for `session` (each id), `project` (old slug(s) + new slug — union, deduped), and `memory` (each id) so every open tab refetches live. Composable: `useSessions().reassign` / `.reassignMany`.

UI: `app/components/sessions/ReassignProjectModal.vue` — a shared modal (single session from the detail page's **Move** button, or a multi-select bulk move from the list's action bar). A `USelectMenu` lists existing projects plus a `'__create__'` sentinel ("➕ Create new project…") that inline-creates via `useProjects().create` before reassigning. An optional "Auto-route future sessions here" toggle (shown only when a `cwd` is known) pre-fills the prefix input from the session's `cwd` and, when checked, passes `pathPrefix` to register it.

**Plan correction (found in browser E2E, fixed in `046ddc9`):** `ReassignProjectModal.vue` lives in `components/sessions/`, so Nuxt's auto-import gives it the **dir-prefixed** name `SessionsReassignProjectModal` — the bare `<ReassignProjectModal>` tag used by both pages resolved to nothing (silent no-op, no console error) until each page added an explicit `import ReassignProjectModal from '~/components/sessions/ReassignProjectModal.vue'`. **Lesson: a component in a `components/<subdir>/` referenced by its bare (non-prefixed) tag name must be explicitly imported** — Nuxt's auto-import name for it is the prefixed form, not the bare one.

### Re-resolve backfill (existing projects only)
`scripts/reresolve-uncategorized.ts` re-resolves sessions currently `uncategorized`/`NULL` against **existing** projects only — resolver order `git_remote key → longest path-prefix → cwd leaf-basename label` — and cascades agent memories the same way `reassignSession` does. **Never auto-creates.** Idempotent; `--dry-run` supported. Not yet run on prod (dev dry-run: would move 14/399 sessions).

## Follow-ups
Token-cost ($) display; deeper Hermes/imsg shape support; `sess_summary_state.model` per-row attribution (column exists, unwritten). Session-list `selectedIds` isn't pruned when a filter hides a selected row (deferred minor).
