---
title: Sessions View
status: shipped
cycle: 24
updated: 2026-06-16
---

# Sessions View

Browse the Claude Code / Hermes session transcripts ingested by the hooks, with token + tool stats, assistant reasoning, and full tool-call detail. Capture fidelity was upgraded in **cycle 13 phase 2** (bridget parity).

## Ingestion (`server/services/sessions.ts` + `transcript-parse.ts`)

The hook (`POST /api/hooks/cc/[event]` for liveness/metadata, `POST /api/hooks/cc/transcript` for the JSONL delta) feeds `ingestTranscript`, which calls the pure `parseTranscriptLines`. Captured per message (first-class columns since phase 2):

- `content` (text blocks) + `thinking` (thinking blocks, kept separate), `model`, `stop_reason`, `request_id`, `parent_uuid`, `is_sidechain`, and the raw `usage` jsonb. Idempotent on `(session_id, external_uuid)` (synthetic uuid when a line has none).
- **`tool_events` table** (new): each `tool_use` block → a row (`tool_name`, `args`, `tool_use_id`, `caller_type`, `is_sidechain`, `phase='pre'`, `message_id` linked to the parent assistant message); the matching `tool_result` closes it (`result`, `exit_status` ok/error, `phase` completed/failed). Idempotent on `(session_id, tool_use_id)`. A **pure tool_result** user line produces no message row but still closes its event.
- **Session columns** (from the `[event]` hook): `machine_id`, `hostname`, `git_branch`, `git_commit`, `git_remote`, `app_version`, plus `ended_at` (set on `SessionEnd`). **`project_id`** (cycle 23) is resolved on ingest via `findOrCreateProject({ gitRemote, cwd })` — canonical match on the normalized git remote (Uncategorized fallback for no-remote); the legacy `project` slug is kept in sync. See [projects.md](projects.md).
- Aggregates recomputed from the real tables on each ingest: `message_count`, `tool_count` (from `tool_events`), `input_tokens`/`output_tokens` (SQL sum over the `usage` column), `started_at`/`last_active` (min/max message `created_at`).

Legacy `messages.metadata.{usage,model,tools,type}` is still dual-written so pre-phase-2 rows keep rendering. (Limitation: a `tool_use` and its `tool_result` are correlated within one ingest batch — they always ship together in a Stop-triggered delta, so this is not a practical gap.)

## API (`server/api/sessions/*`, types in `shared/types/session.ts`)
- `GET /api/sessions?source=&project=` → `SessionListItem[]`, newest first.
- `GET /api/sessions/[id]` → meta only (`getSessionMeta`): session header (`cwd`, `machineId`, `gitBranch`/`gitCommit`/`gitRemote`, `appVersion`, `endedAt`, metadata, counts). No messages. Auth-gated.
- `GET /api/sessions/[id]/messages?since=<iso>` → `messages[]` (incl. `thinking`, `model`, `isSidechain`) + **`toolEvents[]`** (`SessionToolEventDTO`); `?since=` returns only messages after that timestamp for incremental append.

## UI (`app/pages/sessions/{index,[id]}.vue`)
- **List**: cards with source badge, project, title/summary, message/tool/token stats, relative last-active; source/project filters + search.
- **Detail**: header now shows git `branch @ commit`, machine, and app version (from the first-class columns). Transcript turns: user/assistant via sanitized `MdView`; assistant turns show a `model` label and a collapsible **thinking…** block; sidechain (subagent) turns are dimmed (`opacity-70`). Tool turns render real **tool events** — name + exit-status badge + args/result JSON — falling back to the legacy `metadata.tools` badges for old rows. Per-message metadata collapsible retained.

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

## Follow-ups
Token-cost ($) display; deeper Hermes/imsg shape support; `sess_summary_state.model` per-row attribution (column exists, unwritten).
