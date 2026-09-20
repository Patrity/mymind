---
title: Sessions View
status: shipped
cycle: 66
updated: 2026-09-20
---

# Sessions View

Browse the Claude Code / Hermes session transcripts ingested by the hooks, with token + tool stats, assistant reasoning, and full tool-call detail. Capture fidelity was upgraded in **cycle 13 phase 2** (bridget parity).

## Ingestion (`server/services/sessions.ts` + `transcript-parse.ts`)

The hook (`POST /api/hooks/cc/[event]` for liveness/metadata, `POST /api/hooks/cc/transcript` for the JSONL delta) feeds `ingestTranscript`, which calls the pure `parseTranscriptLines`. Captured per message (first-class columns since phase 2):

- `content` (text blocks) + `thinking` (thinking blocks, kept separate), `model`, `stop_reason`, `request_id`, `parent_uuid`, `is_sidechain`, and the raw `usage` jsonb. Idempotent on `(session_id, external_uuid)` (synthetic uuid when a line has none).
- **`tool_events` table** (new): each `tool_use` block → a row (`tool_name`, `args`, `tool_use_id`, `caller_type`, `is_sidechain`, `phase='pre'`, `message_id` linked to the parent assistant message); the matching `tool_result` closes it (`result`, `exit_status` ok/error, `phase` completed/failed). Idempotent on `(session_id, tool_use_id)`. A **pure tool_result** user line produces no message row but still closes its event.
- **Session columns** (from the `[event]` hook): `machine_id`, `hostname`, `git_branch`, `git_commit`, `git_remote`, **`git_root`** (cycle 46 — `git rev-parse --show-toplevel`, sent by `cc-hook.sh`; used transiently as a label-match candidate, never persisted), `app_version`, plus `ended_at` (set on `SessionEnd`). **`project_id`** is resolved on ingest via `findOrCreateProject({ gitRemote, cwd, gitRoot })` — see the **resolver order** below. The legacy `project` slug is kept in sync. See [projects.md](projects.md).
### Message timestamps

`messages.created_at` comes from the JSONL line's own `timestamp` (parsed as an **ISO string**, not a `Date` — `stripNul`/`clampStrings` rebuild objects field by field and a `Date` has no own enumerable properties, so it would arrive as `{}`). A line without a usable timestamp falls back to the column default.

This matters because `started_at`/`last_active` are `min/max(created_at)`, so the column drives session ordering, the Usage tab's per-day costs, and the Home dashboard. Insert-time stamping was invisible for years — normal hook ingest runs seconds behind the message — until the 2026-09-12 backfill replayed a month of history and stamped 53,047 messages "today".

Ingest therefore splits its insert: rows **with** a timestamp use `onConflictDoUpdate` on `created_at`, rows **without** keep `onConflictDoNothing`. A replay can repair history but never invent it, which makes `transcript-backfill.mjs --from-zero` a repair tool as well as a recovery one.

### Wire limits (`server/lib/transcript/ingest-limits.ts`)

The inlet accepts a line at **any** length and caps the batch instead: `MAX_LINES` 50_000 and `MAX_BODY_CHARS` 24_000_000 across all lines. Size management happens on the **parsed** fields — `clampStrings` in `transcript-parse.ts` clamps any string to `MAX_FIELD_CHARS` (200_000) with a `… [truncated N chars]` marker, applied at the same choke point as `stripNul`.

This shape is deliberate. The schema used to cap each line at 100_000 chars, but Zod rejects the **whole batch** on one bad element, and `cc-hook` only advances its byte offset on a 2xx — so a single oversized line (one big tool result; observed up to 2.08 MB) became a permanent head-of-line block, re-POSTing the same doomed payload on every terminal event. ~0.4% of lines wedged 26 sessions and ~270 MB, and **prod message ingest stopped dead from 2026-09-07 to 2026-09-12**. Truncating the raw line is not an option: the parser does `JSON.parse(line)` and skips failures, so a truncated line deletes the message silently.

**Recovery:** `server/assets/setup/transcript-backfill.mjs`, served at `GET /api/setup/transcript-backfill.mjs`. Node 18+, no deps, runs on macOS/Windows/WSL. It walks UUID-named transcripts under `~/.claude/projects` and loops 4 MB chunks until each is caught up — `cc-hook` ships only one chunk per terminal event and never fires again for a dead session, so the hook alone cannot drain a backlog. Safe to re-run (ingest is idempotent). It deliberately skips `subagents/agent-*.jsonl` (the filename is an agent id, not a session id) and Workflow `journal.jsonl`.

- Aggregates recomputed from the real tables on each ingest: `message_count`, `tool_count` (from `tool_events`), `input_tokens`/`output_tokens` (SQL sum over the `usage` column), `started_at`/`last_active` (min/max message `created_at`).

Legacy `messages.metadata.{usage,model,tools,type}` is still dual-written so pre-phase-2 rows keep rendering. (Limitation: a `tool_use` and its `tool_result` are correlated within one ingest batch — they always ship together in a Stop-triggered delta, so this is not a practical gap.)

## API (`server/api/sessions/*`, types in `shared/types/session.ts`)
- `GET /api/sessions?source=&project=` → `SessionListItem[]` (incl. `hostname`), newest first.
- `GET /api/sessions/[id]` → meta only (`getSessionMeta`): session header (`cwd`, `machineId`, `hostname`, `gitBranch`/`gitCommit`/`gitRemote`, `appVersion`, `endedAt`, metadata, counts) plus **`toolNames: string[]`** (cycle 66 — `select distinct tool_name` for this session, which feeds the transcript's tool dropdown). No messages. Auth-gated.
- `GET /api/sessions/[id]/messages` → **two mutually exclusive modes**, see [Cycle 66](#cycle-66--the-transcript-on-ai-elements-keyset-paging-filters-measured-virtualization):
  - **paged** (default): `?before=<cursor>&limit=&hideSidechain=&tool=&q=` → `{ messages (newest-first), toolEvents (this page's only), nextCursor }`.
  - **live-tail**: `?since=<iso>&sinceId=<uuid>` → every message after **that row**, oldest-first, plus its tool events. Carries the same three filter params. `sinceId` is the id of the client's newest held row: the predicate is the `(created_at, id)` row comparison, the same composite the paged read walks. A malformed `sinceId` → **400** (it reaches a `::uuid` cast). Omitting it falls back to the old timestamp-only `>`, which **skips** any row sharing the boundary timestamp — see [the delta](#the-live-tail-delta-is-keyed-on-the-same-composite).
  - `since` **and** `before` together → **400** (guessing which the caller meant would hand it a page it did not ask for). A malformed `before` cursor → **400**.
- `PATCH /api/sessions/[id]` `{ project, pathPrefix? }` — single-session reassignment. See **Reassignment** below.
- `POST /api/sessions/reassign` `{ ids, project, pathPrefix? }` — bulk reassignment.

## UI (`app/pages/sessions/{index,[id]}.vue`)
- **List**: cards with source badge, project, **hostname** (machine that recorded the session), title/summary, message/tool/token stats, relative last-active; source/project/**hostname** filters + search. Per-row checkbox multi-select (`@click.stop` — selecting doesn't navigate) drives a **"Move to project"** bulk-action bar.
- **Detail**: header shows git `branch @ commit`, hostname (machine ID demoted to a tooltip), and app version (from the first-class columns). A **Move** button opens the reassignment modal for this one session. The transcript itself was rebuilt in **cycle 66** — see [that section](#cycle-66--the-transcript-on-ai-elements-keyset-paging-filters-measured-virtualization) for what it renders today (Elements rows, a filter bar, keyset paging). Sidechain (subagent) turns are still dimmed (`opacity-70`). The `MdView`/`<pre>`-JSON row rendering is **gone**. The per-turn **`model` label** and the per-message **metadata disclosure** fell out of the row rewrite and were **restored** in the same cycle, in the row's Elements/Nuxt UI vocabulary (a `UBadge` above the turn; a `Collapsible` holding a json `CodeBlock`).

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

### Virtualized + live-tailing transcript — **superseded by cycle 66**
The transcript was virtualized with `@vueuse/core` `useVirtualList` at a fixed 140px row estimate. That wiring is **deleted**; see [Cycle 66](#cycle-66--the-transcript-on-ai-elements-keyset-paging-filters-measured-virtualization) for what replaced it.

What survives from cycle 24: the page **live-tails** — a watcher on `meta.messageCount` fetches a `?since=` delta when the count grows and appends it — and when the viewport is scrolled up a **"↓ N new"** button appears (count from `countNewSince`), which jumps to the bottom and resumes tailing. The pure scroll helpers still live in `app/utils/transcript-scroll.ts` (`isAtBottom`, `countNewSince`). What changed: the delta now carries the active filters, is keyed on the newest held row's `(created_at, id)` rather than its timestamp alone (see [the delta](#the-live-tail-delta-is-keyed-on-the-same-composite)), and is written into the **paged** query cache (newest page) rather than a flat local list.

### List live-activity pulse (cycle 24 final)
The sessions list now shows a small **pinging dot** (`bg-primary animate-ping`) next to the title of any row whose `lastActive` timestamp just increased. The dot disappears after 2 seconds. This is purely client-side: a `watch` on the `sessions` computed compares each row's `lastActive` against a `Map` of previously-seen values; on advance it sets `pulse[id] = Date.now()` and schedules a delete via `setTimeout`. The underlying list already refetches automatically on SSE `session` events (live-dispatch invalidates `['session','list']`), so counts and timestamps stay current without any additional polling.

## Cycle 46 — reassignment + path-based auto-routing + hostname

### Ingest resolver order (no-git-remote sessions)
`findOrCreateProject({ gitRemote, cwd, gitRoot })` (`server/services/projects.ts`) resolves a session's project. With a git remote, the remote-key branch is unchanged (match `git_remote_key`/`aliases`, else race-safe create). **Without** a git remote, the order is:
1. **Longest registered `path_prefixes` match** — the candidate project whose registered prefix is the longest ancestor-or-equal of `cwd` wins (`longestPrefixMatch`, `server/lib/projects/path-routing.ts`).
2. **Label match** — `cwd` basename, then (if no `cwd` hit) `gitRoot` basename, matched against existing `slug`/`aliases` (`matchProjectByLabel`; match-only, never creates).
3. **Auto-create** — if the `cwd` passes `isAutoCreatable` (see stoplist below), create a new project named for the `cwd` leaf folder, seeding `path_prefixes = [cwd]` so every future session under that folder resolves instantly via step 1.
4. **Uncategorized fallback** — the seeded bucket, unchanged from cycle 23.

`path_prefixes text[]` (migration `0027_bumpy_virginia_dare.sql`) is the routing-roots column — distinct from the passively-accumulated `local_paths` (every observed `cwd`, never used for routing). See [projects.md](projects.md#path_prefixes--routing-roots-distinct-from-local_paths).

**Stoplist** (`isAutoCreatable`, `server/lib/projects/path-routing.ts`) refuses to auto-create from bare/scratch cwds: home roots (`/Users/<x>`, `/home/<x>`, `/mnt/<d>/Users/<x>`), temp dirs (`/tmp`, `/private/tmp`, `/var/tmp` + descendants), and generic leaf names (`documents`, `github`, `downloads`, `desktop`, `src`, `projects`, `code`, `repos`, `dev`, `tmp`, `temp`). These fall through to Uncategorized instead. Pure helpers (`normalizePrefix`, `basenameOf`, `isUnderPrefix`, `longestPrefixMatch`, `isAutoCreatable`) are unit-tested in `test/path-routing.test.ts`.

`git_root` (`git rev-parse --show-toplevel`, sent by `cc-hook.sh` on the `[event]` hook) is a **transient** label-match candidate only — it is never persisted as a session column beyond the label check.

### Hostname surfacing + filter
`hostname` was added to `SessionListItem` (so `SessionMeta` inherits it via the same select). The sessions **list** shows it per row and offers a hostname filter (narrows to sessions from one machine — useful when several machines route to the same "Uncategorized" bucket before prefixes are learned); the **detail** page shows it in the header, demoting the raw `machineId` to a tooltip.

### Reassignment (single + bulk)
`reassignSession(id, { projectSlug, pathPrefix? })` / `reassignSessions(ids, { projectSlug, pathPrefix? })` (`server/services/sessions.ts`), each in one `db.transaction`:
1. **`applyReassign`** — sets `sessions.project`/`project_id`, and **cascades every `scope='agent'` memory for that session** (`memories.sessionId` match) onto the new project. `user`/`world`-scope memories are untouched (they're already project-agnostic).
2. **`registerPrefix`** (optional) — if the caller passes a `pathPrefix`, it's `normalizePrefix`-ed and appended to the target project's `path_prefixes` (deduped) — this is how a manual reassignment **teaches** the router: future sessions under that path auto-route to this project via step 1 of the resolver, without ever hitting auto-create or Uncategorized again.

Endpoints: `PATCH /api/sessions/[id]` `{project, pathPrefix?}` and `POST /api/sessions/reassign` `{ids, project, pathPrefix?}`. Both emit `publishChange` for `session` (each id), `project` (old slug(s) + new slug — union, deduped), and `memory` (each id) so every open tab refetches live. Composable: `useSessions().reassign` / `.reassignMany`.

**Not durable against a live session.** A reassignment only updates the `sessions` row — it doesn't stop the resolver from running again. If the reassigned session is still active and produces another hook event (`Stop`/`SessionEnd` with `cwd`/`git_remote`), `upsertSession` re-runs `findOrCreateProject`, which can overwrite the manual move: a git-remote session snaps back to its remote's project, and a no-remote session reassigned without a registered path prefix re-runs prefix → label → auto-create/uncategorized. Reassignment is really meant for **ended** sessions (the historical backlog); for no-remote sessions, checking "Auto-route future sessions here" on reassign is what makes it stick going forward. A dedicated "pin project" flag that suppresses re-resolution entirely doesn't exist yet.

UI: `app/components/sessions/ReassignProjectModal.vue` — a shared modal (single session from the detail page's **Move** button, or a multi-select bulk move from the list's action bar). A `USelectMenu` lists existing projects plus a `'__create__'` sentinel ("➕ Create new project…") that inline-creates via `useProjects().create` before reassigning. An optional "Auto-route future sessions here" toggle (shown only when a `cwd` is known) pre-fills the prefix input from the session's `cwd` and, when checked, passes `pathPrefix` to register it.

**Plan correction (found in browser E2E, fixed in `046ddc9`):** `ReassignProjectModal.vue` lives in `components/sessions/`, so Nuxt's auto-import gives it the **dir-prefixed** name `SessionsReassignProjectModal` — the bare `<ReassignProjectModal>` tag used by both pages resolved to nothing (silent no-op, no console error) until each page added an explicit `import ReassignProjectModal from '~/components/sessions/ReassignProjectModal.vue'`. **Lesson: a component in a `components/<subdir>/` referenced by its bare (non-prefixed) tag name must be explicitly imported** — Nuxt's auto-import name for it is the prefixed form, not the bare one.

### Re-resolve backfill (existing projects only)
`scripts/reresolve-uncategorized.ts` re-resolves sessions currently `uncategorized`/`NULL` against **existing** projects only — resolver order `git_remote key → longest path-prefix → cwd leaf-basename label` — and cascades agent memories the same way `reassignSession` does. **Never auto-creates.** Idempotent; `--dry-run` supported. Not yet run on prod (dev dry-run: would move 14/399 sessions).

## Cycle 66 — the transcript on AI Elements: keyset paging, filters, measured virtualization

Cycle 3 of the "agent surfaces on AI Elements" program. `/sessions/[id]`'s transcript was built before the Elements components existed and hand-rolled everything; it now pages, filters and virtualizes properly. Spec: [`2026-09-19-sessions-elements-design.md`](../superpowers/specs/2026-09-19-sessions-elements-design.md). Handover: [`2026-09-20-sessions-elements.md`](../handovers/2026-09-20-sessions-elements.md).

### Ordering now includes `id` — and that changes how existing transcripts render

Every **paged** query orders by **`(created_at DESC, id DESC)`**. Measured on prod (2026-09-19): **58,417 of 228,692 messages — 26% — share a `created_at` with another message in the same session**, and the largest single tie group holds **615 rows at one identical timestamp**. Ordering by `created_at` alone left those groups unspecified (Postgres could return them differently between requests), so a timestamp-only pagination cursor would silently skip or repeat whole blocks.

Adding `id` (a UUID: arbitrary but **stable**) makes it deterministic. It is a correctness fix, but it is also a **visible change**: rows inside a tie group can now render in a different order than they used to. Nothing is lost or duplicated — the sequence within a tie group is simply now fixed, and fixed by UUID rather than by insertion luck.

### The live-tail delta is keyed on the same composite

`getSessionMessages` (the `?since=` read) orders `asc(created_at), asc(id)` and compares `(created_at, id) > ($ts, $id)` — the mirror of the paged read. Before that, it asked for `created_at > $since` on the timestamp alone, and `$since` was the `createdAt` of the client's newest held row: **any row ingested afterwards carrying that same `created_at` fell outside a strict `>` and was never delivered**, and because the cursor then advanced past it, it was skipped for the rest of the session rather than merely delayed. With 26% of messages sharing a timestamp with a sibling, a boundary landing inside a tie group is the expected case. The defect **pre-dates cycle 66** (identical at `09a400e`) and was closed here because the composite-cursor machinery made it a two-line change. The client sends the row whole (`?since=` + `?sinceId=`); covered in `test/sessions-paging.db.test.ts` by a row inserted at exactly the cursor timestamp with a higher id.

### The cursor and the index

```
cursor := base64("<createdAt ISO>|<id>")
```

Pure `encodeCursor`/`decodeCursor` in `shared/utils/session-cursor.ts` (unit-tested, including six malformed inputs that must be **rejected**, never coerced). The cursor is opaque so nothing client-side starts parsing it. A malformed `before` → **400**. The client has **no special handling for that status**: it surfaces it like any other failed page — as the top retry row if pages are already loaded, or as the transcript's error state with a Retry if it was the first page. There is no client-side "start over" that drops the cursor and refetches from the newest end; the spec asked for one, and it is not built. In practice the literal case is unreachable — cursors live only inside the vue-query cache, never in the URL and never bookmarked — so the 400 can only come from a hand-crafted request.

Migration **`0044_low_pride.sql`** adds:

```sql
CREATE INDEX "messages_session_created_idx" ON "messages"
  USING btree ("session_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
```

Additive, non-blocking, and column order matches the query's `ORDER BY` so the keyset predicate drives straight off it. Applied on dev; **not yet applied on prod** as of this writing.

### The paged read (`getSessionMessagesPage`, `server/services/sessions.ts`)

| Param | Meaning |
|---|---|
| `before` | cursor; return the page immediately **older** than it |
| `limit` | default **100**, hard cap **200** |
| `hideSidechain` | `is_sidechain = false` |
| `tool` | `exists (select 1 from tool_events where message_id = messages.id and tool_name = $)` |
| `q` | `content ilike %q%` (covered by `messages_content_trgm`) |

- Selects `limit + 1` rows; the extra row is what sets `nextCursor` (encoded from the page's **last** row), so `nextCursor === null` genuinely means exhausted.
- **Limit coercion is explicit**, not `Math.min`/`Math.max`: `Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT`. `Math.min`/`Math.max` propagate `NaN`, and drizzle gates its `LIMIT` clause on `typeof limit === 'number' && limit >= 0` — false for `NaN` — so an unclamped `NaN` **omits `LIMIT` entirely and returns the whole session unbounded**, while `rows.length > NaN` is always false so `hasMore`/`nextCursor` silently go dead. See the handover; this is the cycle's most instructive bug.
- **Tool events are per-page.** The old `getSessionMessages` fetched *every* tool event for the session on *every* request (up to 3,122 rows) and the client de-duplicated by id to cope. Each page now carries only its own messages' events (`where message_id in (page ids)`, fully parameterised by drizzle), and the client-side de-dup is deleted.
- **Filters are server-side, always.** `applyMessageFilters()` builds the WHERE clause and is shared **verbatim** by the paged read and the live-tail delta, so the two cannot drift into filtering differently. Filtering in the client would make "load 100" yield an arbitrary number of visible rows.

`SessionMeta.toolNames` (`select distinct tool_name … where session_id = $1`, covered by `tool_events_session_idx`) gives the dropdown this session's tools rather than all 163 in the database.

### The transcript component (`app/components/sessions/SessionTranscript.vue`)

**`@tanstack/vue-virtual`** (same family as the `@tanstack/vue-query` already in the app) replaces `useVirtualList`. Rows are genuinely variable now — rendered markdown, tool cards, expand-in-place — so they are **measured** via `measureElement` instead of guessed at 140px. `getItemKey` is the **message id, not the index**, so the measurement cache survives a prepend that shifts every index by 100.

- **Pages load upward.** The view opens at the **newest** end; scrolling up loads the page of older messages. Each page arrives newest-first and the page component reverses **both levels** (`[...pages].reverse().flatMap(p => [...p.messages].reverse())`) so the transcript reads oldest-at-top. `.slice()`/spread before `.reverse()` is load-bearing — query data is read-only.
- **Scroll anchoring on prepend** is the load-bearing detail: `anchorAfterPrepend()` (`app/components/sessions/anchor.ts`, unit-tested without a DOM) computes the restore, and the component waits for the virtualizer's own **`onChange`** completion signal with a **double-`requestAnimationFrame` fallback racing it** — a restore whose delta is 0 fires no scroll event at all, so a pure-signal wait would hang. Measured on a real 4,760-message session: 10 consecutive pages, **0px drift every time**, ~410ms per page, 26-29 DOM rows across 129,017px of content.
- **`overflow-anchor: none`** on the scroll root so the browser's own scroll anchoring can never race the restore.
- **A failed older page never clears the transcript.** The top sentinel becomes a retry row; loaded rows stay put. Both sentinel states are pinned to `min-h-12` because the spinner (40px) → retry row (48px) swap was measured pushing every row down 8px.
- **A failed FIRST page is its own state, never the empty state.** With no rows the sentinel's retry row is unreachable (it lives in the branch that needs rows), and `isPending` is false once a query has errored — so the empty branch used to win and a 5,000-message session reported "No messages in this session", with a reload as the only way out. A fourth branch now renders "Couldn't load this transcript" + **Retry**, which emits `reload` and the page answers with `refetch()` (not `fetchNextPage` — there is no page to continue from). `loading` is `isPending || (isFetching && no rows)` because a query keeps `status: 'error'` while it retries, so `isPending` alone would leave the Retry looking inert. Browser-validated by forcing every `/messages` request to fail.
- **Paging is triggered from both an IntersectionObserver and the scroll handler.** The observer alone could stall: it fires only on *changes* and delivers asynchronously, and virtual-core can correct `scrollTop` past the trigger zone before the callback lands. `requestedAtLength` makes the request idempotent so the two triggers cannot stack.
- **Bottom pinning is hand-rolled**, not `virtualizer.scrollToIndex` (which re-targets the end for up to 5s and yanks a reader who scrolled away). Each pin gets its **own `AbortController`** and its own listener closure registered with `{ signal }`, and the loop is gated on `followTail` — so scrolling away by keyboard or scrollbar (neither fires `wheel`/`touchstart`) stops the pin too. A `useResizeObserver` re-pins for 2.5s after a pin, because rows grow asynchronously as markdown renders (measured: the initial autoscroll settled 117px short otherwise, which silently disabled live-tail follow).

### The row (`app/components/sessions/TranscriptRow.vue`)

Elements **row primitives**, not the Elements `Conversation` — `Conversation` owns its own scroll container and stick-to-bottom behaviour, which fights a virtualizer.

| Row part | Renders with |
|---|---|
| user / assistant body | `Message`, `MessageContent`, `MessageResponse` (markdown) |
| `thinking` | `Reasoning`, `ReasoningTrigger`, `ReasoningContent` |
| tool event | `Tool`, `ToolHeader` (`type="dynamic-tool"`), `ToolContent`, `ToolInput`, `ToolOutput` |
| `model` | a neutral/subtle `UBadge` above the turn (only when the row carries one) |
| `metadata` | `Collapsible` + `CollapsibleTrigger`/`CollapsibleContent` (the same primitive `Reasoning` and `Tool` use) around a json `CodeBlock`; the content unmounts while closed, so a row nobody opens pays nothing under the virtualizer |

A pure adapter, `sessionToolState()` (`app/lib/sessions/tool-state.ts`, unit-tested), bridges a session tool event (`args`/`result`/`exitStatus`/`phase`) onto the AI SDK state machine the Elements components expect (`output-available` | `output-error`, case-insensitively on `error`/`failure`/`failed`). It is computed **once per event** into a map keyed by event id, not three times per event in the template.

**Two character caps, for two different reasons:**
- `PREVIEW_CHARS = 2_000` on the **collapsed** body. CSS `line-clamp-6` only *hides* overflow — the full string still flows into `vue-stream-markdown` and is fully parsed and laid out. Measured: the 279,751-char prod message rendered a collapsed `<p>` holding 300,010 chars at 3,243px tall; with the cap, 2,000 chars at 171px. Under a virtualizer that mounts and unmounts rows on every scroll tick, that parse would have undone the whole cycle.
- `MAX_EXPANDED = 20_000` on the **expanded** body, with a "Showing the first 20,000 of N characters" notice.

`clampable` (the "Show more" affordance, at >400 chars) and `truncated` both key off the **original** length, so the preview cap does not change which rows offer to expand. A preview can cut mid-markdown; that is accepted (a fixture with an unclosed ` ```js ` fence straddling the 2,000-char boundary renders without throwing).

### The filter bar (`app/components/sessions/TranscriptFilters.vue`)

Three filters, all server-side: **find-in-session** (`UInput`, debounced 300ms — every keystroke is a new query key and a round trip), **by tool** (`USelectMenu` over `meta.toolNames`), and **hide subagent** (`USwitch`). A fourth — "only tools / only errors" — was considered and rejected in brainstorming.

Two traps the implementation works around, both worth knowing before touching this file:
- **The model object is replaced wholesale on every change**, never mutated in place. `useSessions` reads the filters through `toValue`, which does **not** unwrap a plain `reactive()` object: a bare reactive registers no dependency, the query key never changes, and a filter change silently returns the old pages. The page passes a `ref`.
- **`USelectMenu` throws on an empty-string item value** (it takes the whole popover down), so "All tools" carries an `__all__` sentinel.

Filters live **inside the query key** (`messagePagesKey(id, filters)`), so changing one is a new query and a clean first page with no manual reset and no stale pages bleeding across filters. The transcript is remounted on a filter change (`:key`) so its scroll/tail state starts clean too.

### Deleted this cycle

The fixed-height `useVirtualList` wiring and its 140px estimate; the 300-character line clamp on message bodies; the raw `<pre>` JSON dumps of tool `args`/`result`; the client-side tool-event de-dup and the whole-session tool-event fetch that required it; the `useSessionMessages` composable (the unfiltered whole-transcript read it stood for no longer exists — the endpoint answers with a page).

## Follow-ups
Token-cost ($) display; deeper Hermes/imsg shape support; `sess_summary_state.model` per-row attribution (column exists, unwritten). Session-list `selectedIds` isn't pruned when a filter hides a selected row (deferred minor).

From cycle 66: **migration `0044_low_pride.sql` has not been applied to prod**; **at 375px the resizable metadata panel squeezes the transcript pane to 0px**, so the filter bar is unreachable on mobile (pre-existing split-pane behaviour, measured identically before the cycle — MyMind task `9745f72d`); **read-around-a-search-hit** (landing on a message from global search and loading N before/after it) is deferred — it is a different cursor mode, and `q` narrows the list to matches instead; a malformed-cursor **400 has no client-side "start over"** — it surfaces as an ordinary failed page (see [the cursor](#the-cursor-and-the-index)).
