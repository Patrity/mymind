---
title: Sessions View
cycle: 11
status: shipped
date: 2026-06-03
feedback: ../../scope-feedback.md
shipped:
  - "Ingestion captures token usage + tool uses: pure parseTranscriptLines (TDD, 11 tests) extracts per-message metadata (model, usage, tool names) from CC JSONL; sessions gained input_tokens/output_tokens/tool_count, messages gained metadata jsonb. Aggregates recompute from all messages on re-ingest (no double-count)."
  - "Sessions service + API: listSessions({source?,project?}) + getSession(id) (with messages); GET /api/sessions + /api/sessions/[id] (auth-gated)."
  - "Sessions UI: /sessions/index.vue (list — source badge, project, title/summary, message/tool/token stats, relative last-active, source/project filters + search) and /sessions/[id].vue (header stats + role-labeled transcript turns, tool-name badges, per-message metadata collapsible, MdView markdown). Sidebar 'Sessions' nav."
deferred:
  - "Token cost ($) computation — only raw token counts shown."
  - "Hermes/imsg transcript shapes beyond best-effort (parser is CC-focused but tolerant)."
  - "Session summarization worker (title/summary generation) still deferred from cycle 5 — sessions without a summary show '(untitled session)' / first content."
  - "listSessions builds a raw sql where when both filters present (values are parameterized); could refactor to and()/eq() for type-safety."
next_seam: "All round-2 feedback (cycles 7–11) is addressed. Remaining backlog lives across the handovers: a session-summarization worker, GitHub→memory, bridget data migration, ::callout naming, image semantic search, and a push to a git remote when desired."
validation: "typecheck + build + 139 tests; hook ingest captured 120 in / 60 out / 1 tool with per-message metadata; playwright: sessions list renders 5 sessions with stats, detail renders transcript + header stats + metadata collapsible; nav present. Bug found+fixed: nested route (sessions.vue had no <NuxtPage/>) → flattened to sessions/index.vue."
---

# Cycle 11 — Sessions View (handover)

Round-2 batch 5 (final): browse the CC/Hermes session transcripts ingested by the cycle-5 hooks, now with token + tool stats.

## What changed
- **Ingestion** (`server/services/{sessions,transcript-parse}.ts`): the transcript parser now also extracts `message.usage` (→ session input/output token totals), `tool_use`/`tool_result` (→ `tool_count` + per-message `metadata.tools`), and `model`. Aggregates are recomputed from the full message set on each ingest, so re-posting a transcript is idempotent.
- **API** (`server/api/sessions/*`): read-only list + detail.
- **UI** (`app/pages/sessions/{index,[id]}.vue`): a sessions list with stats/filters and a detail view rendering the raw transcript as role-labeled turns (assistant text via sanitized `MdView`, tool turns showing tool names) + a per-message metadata toggle (model/usage).

## Gotcha (fixed)
Nuxt treats `pages/sessions.vue` + `pages/sessions/[id].vue` as a parent shell + child; without a `<NuxtPage/>` in the parent the detail never renders. Fixed by flattening to `pages/sessions/index.vue` + `pages/sessions/[id].vue` (sibling routes).

## Where things live
`server/services/transcript-parse.ts` (pure parser), `server/services/sessions.ts` (ingest + list/get), `server/api/sessions/*`, `shared/types/session.ts`, `app/pages/sessions/{index,[id]}.vue`, `app/composables/useSessions.ts`.
