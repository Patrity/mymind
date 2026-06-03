---
title: Sessions View
status: shipped
cycle: 11
updated: 2026-06-03
---

# Sessions View

Browse the Claude Code / Hermes session transcripts ingested by the memory hooks, with token + tool stats.

## Ingestion (cycle 5 + cycle 11)
Hooks (`POST /api/hooks/cc/transcript`) feed `server/services/sessions.ts ingestTranscript`, which calls the pure `server/services/transcript-parse.ts parseTranscriptLines`:
- text content per message (role + content), idempotent on `(session_id, external_uuid)`
- `message.usage` → summed into `sessions.input_tokens` / `output_tokens`; raw usage stored in `messages.metadata.usage`
- `tool_use` / `tool_result` parts → `sessions.tool_count` + `messages.metadata.tools`
- `message.model` → `messages.metadata.model`
Aggregates recompute from the full message set on each ingest (idempotent re-ingest).

## API (`server/api/sessions/*`)
- `GET /api/sessions?source=&project=` → `SessionListItem[]` (source/project/title/summary/messageCount/toolCount/input+output tokens/started/lastActive), newest first.
- `GET /api/sessions/[id]` → `SessionDetail` (+ cwd/metadata + `messages[]` with role/content/metadata). Auth-gated. Types in `shared/types/session.ts`.

## UI (`app/pages/sessions/{index,[id]}.vue`)
- **List**: cards with source badge, project, title/summary, message/tool/token stats, relative last-active; source/project `USelect` filters + search.
- **Detail**: header stats (messages, tools, in/out tokens, started/last-active, cwd/git); transcript as role-labeled turns (user/assistant via sanitized `MdView`, tool turns show tool-name badges); per-message metadata collapsible (model/usage).
- Sidebar "Sessions" nav. (Routes are flat siblings under `pages/sessions/` — a parent `sessions.vue` without `<NuxtPage/>` would hide the detail.)

## Follow-ups
Token-cost ($) computation; session summarization worker (titles/summaries); deeper Hermes/imsg shape support.
