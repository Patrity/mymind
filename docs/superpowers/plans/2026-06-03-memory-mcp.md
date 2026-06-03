# Memory + MCP Server + Hook Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Reimplement the bridget memory service in TS: ingest CC/Hermes transcripts via HTTP hooks, enrich into deduped/embedded/reviewable memories, semantic search over memories+docs, and an MCP server exposing memories/docs/projects/tasks to agents.

**Architecture:** New `memories`/`sessions`/`messages` tables; memory service reuses cycle-2 `embeddings`/`rrf`/`chat`; hook endpoints ingest transcripts; a Nitro task enriches; an MCP server (`@modelcontextprotocol/sdk` StreamableHTTP) wired into a Nitro route.

**Tech Stack:** Nuxt 4, Drizzle/Postgres (pgvector HNSW), `@modelcontextprotocol/sdk` 1.29, local coder LLM, Vitest, curl/JSON-RPC for MCP validation.

**Validation env:** rig reachable (embeddings TEI:8882, reasoning :8004).

---

### Task 1: schema — memories, sessions, messages, enrichment state
**Files:** `server/db/schema/{memories,sessions,messages,mem-enrichment-state}.ts` (+barrel), migration.
- [ ] `memories` (scope, content, tags[], source, embedding halfvec(2560), content_hash, confidence real, evidence jsonb, project, session_id, enriched_at, reviewed_at, created/updated/archived_at). Indexes: scope, tags GIN, content trigram GIN, embedding HNSW cosine, unique content_hash WHERE archived_at IS NULL.
- [ ] `sessions` (id, source, external_id, project, cwd, title, summary, message_count, started_at, last_active, metadata; unique (source, external_id)).
- [ ] `messages` (id, session_id FK, role, content, external_uuid, created_at; unique (session_id, external_uuid)).
- [ ] `mem_enrichment_state` (session_id PK, last_enriched_message_count int, last_run, status, error).
- [ ] Migrate (append HNSW + trigram + partial-unique SQL as in cycle 1/2). Verify via psql. typecheck. Commit.

### Task 2: memory service — CRUD, dedup, hybrid search (TDD dedup)
**Files:** `server/services/memory.ts`, `shared/types/memory.ts`, `test/mem-dedup.test.ts`.
- [ ] Pure `dedupDecision(candidate, existing, {threshold=0.85})` → `{ action:'insert'|'merge'|'skip', mergeId? }` (exact hash → skip/merge; cosine ≥ threshold in same scope/project → merge; else insert). Provide a `cosine(a,b)` helper. TDD it.
- [ ] `createMemory(input)` (embed content, compute hash, run dedupDecision against same-scope/project candidates fetched by vector top-k, then insert or merge evidence), `searchMemories(q, filters)` (hybrid trigram+vector RRF, reuse `embedOne`+`rrfFuse`), `listMemories`, `getMemory`, `updateMemory` (re-embed on content change), `reviewMemory`, `archiveMemory`. DTOs.
- [ ] typecheck + test. Commit.

### Task 3: hook endpoints (transcript ingestion)
**Files:** `server/services/sessions.ts`, `server/api/hooks/cc/[event].post.ts`, `server/api/hooks/cc/transcript.post.ts`. (`/api/hooks` stays auth-gated — bearer token.)
- [ ] `sessions.ts`: `upsertSession({source, externalId, project?, cwd?, metadata?})`, `ingestTranscript({source, externalId, lines})` — parse Claude Code JSONL lines (each line JSON; extract role+content+uuid from the message shape; be tolerant of shapes), upsert `messages` (idempotent), bump message_count/last_active.
- [ ] `[event].post.ts`: upsert session from a hook payload (body `{ source?, external_id, project?, cwd?, ... }`); return ok. `transcript.post.ts`: `{ source, external_id, lines: string[] }` → ingestTranscript; return `{ ingested }`.
- [ ] Smoke: POST a session + a few synthetic CC JSONL lines → messages rows created; re-POST same lines → no duplicates. Commit.

### Task 4: enrichment loop (validate vs rig)
**Files:** `server/services/memory-enrich.ts`, `server/tasks/enrich-memories.ts`, `server/api/admin/memory-enrich-run.post.ts`, `test/mem-extract-parse.test.ts`.
- [ ] Tolerant `parseMemories(raw)` (array of candidates) — TDD.
- [ ] `runMemoryEnrichment({limit})`: select sessions with ≥6 messages whose message_count grew since `mem_enrichment_state.last_enriched_message_count` (or never enriched); assemble transcript (cap chars); `chat('reasoning', [...strict JSON system prompt...])`; parse; for each candidate `createMemory({...scope, content, tags:[...,'enrichment','unreviewed'], confidence, source:'enrichment:<sessionId>', sessionId, evidence})` (dedup handles merge); upsert `mem_enrichment_state`. Per-session try/catch.
- [ ] Nitro task `enrich-memories` (schedule e.g. `'*/15 * * * *'`) + `POST /api/admin/memory-enrich-run`.
- [ ] Validate vs rig: ingest a synthetic session of a few messages about a decision; run enrich; confirm ≥1 memory row created (embedded, scope set) by the real LLM. Commit.

### Task 5: MCP server
**Files:** `pnpm add @modelcontextprotocol/sdk`; `server/lib/mcp/server.ts` (build McpServer + register tools), `server/api/mcp/index.post.ts` (+ maybe GET) wiring StreamableHTTPServerTransport to the h3 event's Node req/res.
- [ ] Build an `McpServer` registering tools: `search_memories`, `save_memory`, `get_recent_memories`, `search_docs`, `search_projects`, `create_project`, `edit_project`, `create_task`, `search_tasks`, `edit_task` — each delegating to the existing services with zod input schemas.
- [ ] Wire `StreamableHTTPServerTransport` (stateless mode is simplest) into the Nitro route; access `event.node.req`/`event.node.res`. Bearer-token auth (reuse api_tokens check) before handling. `/api/mcp` stays under the auth middleware OR do token check inside (ensure it's reachable by machine clients with a token).
- [ ] Validate: with a bearer token, `curl` JSON-RPC `initialize` then `tools/list` (expect the tool list) then a `tools/call` of `search_memories` (expect results). Document the exact curl. Commit.

### Task 6: Memories UI
**Files:** `app/composables/useMemories.ts`, `app/pages/memories.vue`, sidebar nav.
- [ ] List/search memories (scope `USelect` filter, search box), cards (content, scope badge, tags, confidence, source, reviewed state), Mark reviewed + Archive actions. Sidebar "Memory" nav (`i-lucide-brain`).
- [ ] typecheck + build. Commit.

### Task 7: E2E + handover + merge
- [ ] Gates typecheck/build/test.
- [ ] Integration recap: hook ingest → enrich → memory; MCP tools/list + search over HTTP with token; Memories UI renders + review works (playwright-cli for the UI).
- [ ] Handover (deferrals: summarization worker, reranker, multi-user); wiki `memory.md` + `mcp.md`; roadmap cycle-5 → shipped. Final holistic review (focus: MCP auth — agents get broad data access; dedup correctness; hook auth); fix blockers; merge.

---

## Self-Review
Coverage: memory/sessions/messages schema (T1) ✓ · memory CRUD+dedup+hybrid search (T2) ✓ · hook ingestion (T3) ✓ · LLM enrichment loop (T4) ✓ · MCP server tools (T5) ✓ · memories UI (T6) ✓ · validation/docs/merge (T7) ✓. Pure units: dedupDecision/cosine, parseMemories. Reuses cycle-2 embeddings/rrf/chat. MCP + hooks are token-auth'd (machine clients). Nothing auto-trusts: enrichment memories tagged 'unreviewed'.
