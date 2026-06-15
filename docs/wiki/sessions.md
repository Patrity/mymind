---
title: Sessions View
status: shipped
cycle: 11
updated: 2026-06-15
---

# Sessions View

Browse the Claude Code / Hermes session transcripts ingested by the hooks, with token + tool stats, assistant reasoning, and full tool-call detail. Capture fidelity was upgraded in **cycle 13 phase 2** (bridget parity).

## Ingestion (`server/services/sessions.ts` + `transcript-parse.ts`)

The hook (`POST /api/hooks/cc/[event]` for liveness/metadata, `POST /api/hooks/cc/transcript` for the JSONL delta) feeds `ingestTranscript`, which calls the pure `parseTranscriptLines`. Captured per message (first-class columns since phase 2):

- `content` (text blocks) + `thinking` (thinking blocks, kept separate), `model`, `stop_reason`, `request_id`, `parent_uuid`, `is_sidechain`, and the raw `usage` jsonb. Idempotent on `(session_id, external_uuid)` (synthetic uuid when a line has none).
- **`tool_events` table** (new): each `tool_use` block → a row (`tool_name`, `args`, `tool_use_id`, `caller_type`, `is_sidechain`, `phase='pre'`, `message_id` linked to the parent assistant message); the matching `tool_result` closes it (`result`, `exit_status` ok/error, `phase` completed/failed). Idempotent on `(session_id, tool_use_id)`. A **pure tool_result** user line produces no message row but still closes its event.
- **Session columns** (from the `[event]` hook): `machine_id`, `hostname`, `git_branch`, `git_commit`, `git_remote`, `app_version`, plus `ended_at` (set on `SessionEnd`).
- Aggregates recomputed from the real tables on each ingest: `message_count`, `tool_count` (from `tool_events`), `input_tokens`/`output_tokens` (SQL sum over the `usage` column), `started_at`/`last_active` (min/max message `created_at`).

Legacy `messages.metadata.{usage,model,tools,type}` is still dual-written so pre-phase-2 rows keep rendering. (Limitation: a `tool_use` and its `tool_result` are correlated within one ingest batch — they always ship together in a Stop-triggered delta, so this is not a practical gap.)

## API (`server/api/sessions/*`, types in `shared/types/session.ts`)
- `GET /api/sessions?source=&project=` → `SessionListItem[]`, newest first.
- `GET /api/sessions/[id]` → `SessionDetail`: session header (`cwd`, `machineId`, `gitBranch`/`gitCommit`/`gitRemote`, `appVersion`, `endedAt`, metadata) + `messages[]` (now incl. `thinking`, `model`, `isSidechain`) + **`toolEvents[]`** (`SessionToolEventDTO`: name/args/result/exitStatus/phase/messageId). Auth-gated.

## UI (`app/pages/sessions/{index,[id]}.vue`)
- **List**: cards with source badge, project, title/summary, message/tool/token stats, relative last-active; source/project filters + search.
- **Detail**: header now shows git `branch @ commit`, machine, and app version (from the first-class columns). Transcript turns: user/assistant via sanitized `MdView`; assistant turns show a `model` label and a collapsible **thinking…** block; sidechain (subagent) turns are dimmed (`opacity-70`). Tool turns render real **tool events** — name + exit-status badge + args/result JSON — falling back to the legacy `metadata.tools` badges for old rows. Per-message metadata collapsible retained.

## Validated (2026-06-15)
A crafted transcript (thinking + Bash tool_use + tool_result + SessionEnd w/ git/machine) ingested via the hooks → detail shows `thinking`, model, the Bash event (completed/ok, args+result, message-linked), git branch/commit, machine, and `endedAt`; re-ingest is idempotent (counts steady). Gates: typecheck 0 / test 267 / build.

## Follow-ups (cycle 13 phase 4)
Session **summarization** worker (titles + summaries + `summary_embedding`) and session/message **semantic search** — sessions still show "(untitled)" until phase 4. Token-cost ($) display; deeper Hermes/imsg shape support.
