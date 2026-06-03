---
title: Memory + MCP Server + Hook Endpoints
cycle: 5
status: shipped
date: 2026-06-03
shipped:
  - memories/sessions/messages/mem_enrichment_state schema (memories mirrors bridget mem_entries: scope/content/embedding halfvec(2560)/content_hash/evidence/confidence; HNSW + trigram + partial-unique indexes)
  - memory service — two-stage dedup (exact content_hash skip + semantic cosine>=0.85 merge evidence) + hybrid trigram+vector RRF search (reuses cycle-2 embeddings/rrf); CRUD + review/archive. dedupDecision/cosine TDD (10 tests)
  - CC/Hermes hook endpoints (bearer-token): POST /api/hooks/cc/[event] (session upsert) + /transcript (tolerant CC JSONL parse -> idempotent messages)
  - enrichment loop (server/services/memory-enrich.ts + Nitro task enrich-memories */15 + POST /api/admin/memory-enrich-run): sessions -> reasoning LLM -> deduped/embedded memories tagged 'unreviewed'. parseMemories TDD (14 tests). VALIDATED vs rig (extracted user pref + agent facts)
  - MCP server (@modelcontextprotocol/sdk StreamableHTTP, stateless, token-auth) at POST /api/mcp — 10 tools: search_memories/save_memory/get_recent_memories, search_docs, search_projects/create_project/edit_project, create_task/search_tasks/edit_task. VALIDATED over JSON-RPC (tools/list, search_memories, create_task created a real task)
  - memory API routes + Memories UI (search, scope filter, unreviewed toggle, mark reviewed/archive, sidebar nav + unreviewed badge)
deferred:
  - "Session summarization worker (bridget had title/summary generation) -> defer"
  - "TEI reranker (:8883) to re-score fused memory/doc results -> later"
  - "GitHub-commit -> memory/notes integration (roadmap item) -> not built; add as a scheduled task hitting the repo + reasoning LLM later"
  - "Hermes/imsg transcript shapes beyond Claude Code JSONL (parser is CC-focused, source is generic) -> extend when needed"
  - "MCP stateless mode = no server-initiated notifications (fine for tool calls); no MCP resources/prompts, tools only"
  - "Login-page hydration warning in dev cookie-injection path (pre-existing, non-blocking)"
next_seam: "Cycle 6 (Clipboard) is the last: port copipasta as a /clipboard page (its stack matches — Nuxt4+NuxtUI+better-auth+Drizzle+storage abstraction all already here). Largely a UI + threads/messages schema + SSE port."
validation: "typecheck + build + 74 vitest tests; curl integration (hook ingest -> enrich -> memories; MCP tools/list + search_memories + create_task over JSON-RPC; hybrid memory search); playwright-cli (Memories UI cards + scope filter + mark-reviewed + badge)."
---

# Cycle 5 — Memory + MCP Server + Hook Endpoints (handover)

The big one: MyMind is now the memory + agent-integration hub, reimplementing the Python `bridget-services/memory` design in Nitro/TS. Claude Code/Hermes hooks POST sessions + transcripts; an enrichment loop turns them into deduped, embedded, reviewable memories; memories + docs are semantically searchable; and an MCP server exposes memories/docs/projects/tasks to agents over token-auth'd HTTP.

## Deprecating the Python service
The data model, two-stage dedup, hybrid RRF search, enrichment loop, hook ingestion, and MCP tools are all ported. To cut over: point Claude Code hooks at `https://<host>/api/hooks/cc/*` (bearer token) and the MCP client at `https://<host>/api/mcp` (bearer token). Migrating existing bridget memory rows is a data task, not covered here.

## Key decisions
- **Reuses cycle-2 AI plumbing** (embeddings/rrf/chat) — no duplication.
- **Two-stage dedup** prevents bloat; evidence accumulates on merges.
- **Nothing auto-trusted**: enrichment memories are tagged `unreviewed`; the Memories page "Mark reviewed" is the human gate.
- **MCP stateless StreamableHTTP**: a fresh server+transport per request (cheap, no session store); h3 v1 handoff via `event._handled = true` after `transport.handleRequest(req,res,body)`.
- **Auth**: hooks + MCP are bearer-token (machine clients) via the existing dual-auth middleware + an in-handler token check on /api/mcp.

## Where things live
- Schema: `server/db/schema/{memories,sessions,messages,mem-enrichment-state}.ts`.
- Service: `server/services/{memory,memory-dedup,sessions,memory-enrich}.ts`; `server/lib/ai/memory-extract.ts`.
- Hooks: `server/api/hooks/cc/*`. Enrichment: `server/tasks/enrich-memories.ts`, `server/api/admin/memory-enrich-run.post.ts`.
- MCP: `server/lib/mcp/server.ts`, `server/api/mcp/index.post.ts`.
- UI: `app/pages/memories.vue`, `app/composables/useMemories.ts`, `server/api/memories/*`.
