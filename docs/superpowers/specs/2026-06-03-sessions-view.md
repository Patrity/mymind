---
title: Sessions View
cycle: 11
status: spec
date: 2026-06-03
feedback: ../../scope-feedback.md
---

# Cycle 11 — Sessions View

## Purpose
Surface the Claude Code / Hermes session transcripts already ingested by the cycle-5 hooks (`sessions` + `messages`), with as much metadata as we can extract: raw transcript, message count, tool uses, and token usage.

## Items (from scope-feedback.md → Sessions View)
"See raw transcripts from data submitted via claude code/hermes hooks. As much data as possible — token usage, message count, tool uses, etc."

## Components

### 1. Capture more during ingestion (so there's data to show)
The cycle-5 `ingestTranscript` parses role+content text and skips the rest. Enhance it to also capture, per CC JSONL line:
- **Token usage**: assistant lines carry `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`. Sum per session.
- **Tool uses**: assistant content parts of `type:'tool_use'` (capture tool `name`); `type:'tool_result'` lines. Count per session + record the tool name on the message.
- Store per-message extras in a new `messages.metadata jsonb` (model, usage, tool_use names, type). Aggregate onto `sessions`: `input_tokens`, `output_tokens`, `tool_count` (and keep `message_count`).
- Keep ingestion tolerant + idempotent. (Re-ingesting a transcript updates aggregates.)

### 2. Sessions service + API
- `server/services/sessions.ts`: `listSessions({ source?, project?, limit? })` (newest by last_active; returns source/project/title/summary/message_count/tool_count/tokens/started_at/last_active), `getSession(id)` (session + its messages ordered, each with role/content/metadata).
- API: `GET /api/sessions` (list, filters), `GET /api/sessions/[id]` (detail + messages). Auth-gated.

### 3. Sessions UI
- `app/pages/sessions.vue` — list of sessions (cards/table): source badge, project, title/summary (if summarized; else first message snippet), message count, tool count, token totals, last-active relative time. Filter by source/project + search box (reuse search or a simple filter).
- `app/pages/sessions/[id].vue` — detail: header with stats (messages, tools, input/output tokens, started/last-active, cwd/git if in metadata); the raw transcript rendered as a readable conversation (role-labeled bubbles; assistant/tool turns distinguished; tool_use shows the tool name; markdown content via MdView for assistant text). "As much data as possible" — show model, per-message usage if present (collapsible/raw toggle).
- Sidebar nav "Sessions" (`i-lucide-history` or `i-lucide-messages-square`).

## Testing & validation
- Unit: the enhanced transcript parser (token-sum + tool-count + per-message metadata extraction) is pure-testable — feed sample CC JSONL lines (assistant with usage + tool_use, user, tool_result) → assert aggregates + per-message metadata.
- Integration (rig optional — uses ingested data): POST a transcript with usage + tool_use lines via the hook → confirm session aggregates (tokens, tool_count) + messages carry metadata; sessions list + detail render.
- playwright: sessions list renders; open a session → transcript + stats show.
- Gates: typecheck/build/test.

## Non-goals
Live session streaming; editing transcripts; re-running sessions; full token cost computation (just raw token counts). Hermes/imsg-specific shapes beyond best-effort (parser stays tolerant; CC shape is the priority).

## Definition of done
A Sessions page lists ingested CC/Hermes sessions with message/tool/token stats; a detail view shows the raw transcript + as much metadata as captured. Ingestion now records token usage + tool uses. Wiki `memory.md` (or a new `sessions.md`); handover; roadmap cycle-11 → shipped → **all round-2 feedback addressed**.
