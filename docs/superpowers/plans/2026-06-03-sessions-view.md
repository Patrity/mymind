# Sessions View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Browse ingested CC/Hermes session transcripts with message/tool/token stats; enhance ingestion to capture usage + tool uses.

**Tech Stack:** Nuxt 4 + Nuxt UI v4, Drizzle/Postgres, existing `sessions`/`messages` + hook ingestion (`server/services/sessions.ts`), Vitest, playwright-cli.

---

### Task 1: capture token usage + tool uses in ingestion (TDD the parser)
**Files:** `server/db/schema/{sessions,messages}.ts` (+migration); `server/services/sessions.ts` (enhance `ingestTranscript` + a pure parse helper); `test/transcript-parse.test.ts`.
- [ ] Schema: add to `sessions`: `inputTokens integer default 0`, `outputTokens integer default 0`, `toolCount integer default 0`. Add to `messages`: `metadata jsonb default '{}'`. Migrate.
- [ ] Extract a PURE `parseTranscriptLines(lines: string[]): { messages: {role,content,externalUuid,metadata}[], usage: {input,output}, toolCount }` from the current ingest logic. Per CC JSONL line: text content (as today) PLUS — assistant `message.usage` → sum input/output (incl. cache fields into input if present); content parts `type:'tool_use'` → push tool name into that message's `metadata.tools` + increment toolCount; capture `message.model` into metadata; `type:'tool_result'` lines counted as tool activity. Tolerant: never throw on a weird line.
- [ ] `ingestTranscript` uses the helper, upserts messages (with metadata), and updates session aggregates (`inputTokens`/`outputTokens`/`toolCount` = recomputed totals for the session, or incremented — recompute from all the session's messages for correctness on re-ingest), `messageCount`, `lastActive`.
- [ ] `test/transcript-parse.test.ts`: sample lines (user; assistant with `usage` + a `tool_use` part; tool_result) → assert summed tokens, toolCount, per-message metadata (tools, model). Red→green.
- [ ] Validate (hook): POST a transcript with usage+tool_use lines → `select input_tokens, output_tokens, tool_count, message_count from sessions where ...` reflects them; a message row's `metadata` has the tool name. typecheck+test. Commit.

### Task 2: sessions service + API
**Files:** `server/services/sessions.ts` (add list/get), `server/api/sessions/index.get.ts`, `server/api/sessions/[id].get.ts`, `shared/types/session.ts`.
- [ ] `listSessions({source?, project?, limit=50})` → newest by last_active, return id/source/project/title/summary/messageCount/toolCount/inputTokens/outputTokens/startedAt/lastActive. `getSession(id)` → the session + its messages (ordered createdAt, with role/content/metadata).
- [ ] `GET /api/sessions` (query source/project) + `GET /api/sessions/[id]`. Auth-gated. DTOs in shared/types.
- [ ] Smoke: `curl /api/sessions | jq length`, `curl /api/sessions/<id> | jq '{messageCount, messages: (.messages|length)}'`. Commit.

### Task 3: Sessions UI
**Files:** `app/pages/sessions.vue`, `app/pages/sessions/[id].vue`, `app/composables/useSessions.ts`, sidebar nav.
- [ ] `useSessions`: `list(params?)`, `get(id)`.
- [ ] `sessions.vue`: list (cards/`UTable`) — source badge, project, title/summary (or first-message snippet), messageCount, toolCount, token totals, relative last-active; filter by source/project (USelect, sentinels) + search input. Click → `/sessions/<id>`.
- [ ] `sessions/[id].vue`: header stats row (messages, tools, input/output tokens, started/last-active, cwd/git from metadata if present); transcript as role-labeled turns (user/assistant/tool) — assistant text via `MdView`, tool_use turns show the tool name; a "raw"/metadata toggle per message (collapsible) showing model + usage. Back link to /sessions.
- [ ] Sidebar "Sessions" nav (`i-lucide-history`). typecheck+build. Commit.

### Task 4: validation + handover + merge
- [ ] Gates typecheck/build/test.
- [ ] playwright-cli: sessions list renders (there are sessions from cycle-5 ingestion); open one → transcript + stats show. Screenshot.
- [ ] Handover; wiki (new `sessions.md` or extend `memory.md`); roadmap cycle-11 → shipped (ALL ROUND-2 DONE). Final review (focus: /api/sessions auth + the transcript renders untrusted content safely — MdView sanitizes; no v-html of raw). Merge.

---

## Self-Review
Coverage: ingestion captures tokens+tools (T1) ✓ · sessions service+API (T2) ✓ · list + detail UI (T3) ✓ · validation/docs/merge (T4) ✓. Pure unit: parseTranscriptLines (tokens/tools/metadata). Re-ingest recomputes aggregates (idempotent). Transcript rendered via MdView (sanitized) — no raw v-html.
