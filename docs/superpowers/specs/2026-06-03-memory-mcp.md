---
title: Memory + MCP Server + Hook Endpoints
cycle: 5
status: spec
date: 2026-06-03
supersedes: none
---

# Cycle 5 — Memory + MCP Server + Hook Endpoints

## Purpose
Reimplement (in Nitro/TS) the proven `bridget-services/memory` design so MyMind becomes the memory + agent-integration hub, deprecating the Python service. Ingest Claude Code/Hermes session transcripts via HTTP hooks, enrich them into durable memories with an LLM, search everything (memories + docs) semantically, and expose an MCP server so agents can read/write memories, docs, projects, and tasks.

## Locked decisions (roadmap)
Reuse cycle-2 AI plumbing: `embeddings.embed`/`embedOne`, `rrf.rrfFuse`, `chat.chat` (reasoning role = local coder model). Memory embeddings are `halfvec(2560)`. Every AI-written memory is reviewable (`reviewed_at`).

## Components

### Data model (ported from bridget, simplified for single-user)
- `memories`: `id` uuid, `scope` text ('user'|'agent'|'world'), `content` text, `tags` text[], `source` text, `embedding halfvec(2560)`, `content_hash` text (sha256, exact-dedup), `confidence` real, `evidence` jsonb (array of `{sessionId, msgIds, reasoning, mergedAt}`), `project` text, `session_id` uuid null, `enriched_at` timestamptz, `reviewed_at` timestamptz, `created_at`, `updated_at`, `archived_at`. Indexes: scope, tags GIN, content trigram GIN, embedding HNSW cosine; unique content_hash where archived_at null.
- `sessions`: `id` uuid, `source` text ('claude_code'|'hermes'|...), `external_id` text, `project`, `cwd`, `title`, `summary`, `message_count` int, `started_at`, `last_active`, `metadata` jsonb. Unique (source, external_id).
- `messages`: `id` uuid, `session_id` FK, `role`, `content`, `external_uuid` text, `created_at`. Unique (session_id, external_uuid).
- Enrichment bookkeeping: `mem_enrichment_state` (session_id PK, last_enriched_message_count, last_run, status). 

### Memory service
- CRUD + `searchMemories(q, {scope?, project?, tags?})` = hybrid trigram+vector RRF (reuse cycle-2 helpers; query embedded via `embedOne`). Embed memory content on insert/update.
- **Two-stage dedup** on insert: exact `content_hash` match → skip/merge evidence; else semantic cosine ≥ 0.85 within same (scope, project) → merge evidence into existing; else insert. (Port the bridget writer logic.)
- `reviewMemory(id)` sets `reviewed_at`; `archiveMemory(id)`.

### Hook endpoints (bearer-token auth)
- `POST /api/hooks/cc/[event]` — upsert a `sessions` row from a Claude Code hook event (SessionStart/Stop/SessionEnd/etc): liveness + metadata only.
- `POST /api/hooks/cc/transcript` — body `{ sessionId|external_id, source, lines: string[] }`: parse JSONL transcript lines → upsert `messages` (idempotent via external_uuid), bump session message_count/last_active.

### Enrichment loop
- `server/services/memory-enrich.ts` `runMemoryEnrichment({limit})` + Nitro task `enrich-memories` + `POST /api/admin/memory-enrich-run`: select sessions with ≥N real messages whose message_count grew since last enrichment; assemble a transcript window; call `chat('reasoning', ...)` with a strict JSON system prompt (atomic durable memories with scope/content/tags/confidence/evidence); parse (tolerant); dedup + write each candidate; record `mem_enrichment_state`. Tags include 'enrichment','unreviewed'.

### MCP server
- `server/api/mcp/[...].ts` (or `/mcp`) — an MCP server using `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` wired into the Nitro h3 handler (adapt the Node req/res from the h3 event). Bearer-token auth (reuse api_tokens). Tools:
  - `search_memories(query, scope?, project?, limit?)`, `save_memory(content, scope, project?, tags?)`, `get_recent_memories(limit?)`
  - `search_docs(query, limit?)` (reuse document searchDocs)
  - `search_projects(query?)`, `create_project(name, description?)`, `edit_project(slug, ...)`
  - `create_task(title, ...)`, `search_tasks(status?, project?)`, `edit_task(id, ...)`
- Validate via JSON-RPC over HTTP (initialize + tools/list + a tools/call) with a bearer token.

### Memories UI
- `app/pages/memories.vue` — list/search memories (scope filter, search box), show content/tags/scope/confidence/source, mark reviewed, archive. Sidebar "Memory" nav (`i-lucide-brain`). Badge: count of unreviewed enrichment memories (optional).

## Testing & validation
- Unit (vitest): two-stage dedup decision (pure `dedupDecision(candidateHash, candidateVec, existing[])` → 'insert'|'merge'|'skip'); memory-extraction JSON parser (tolerant); MCP tool input schemas.
- Integration (rig): POST a fake CC session + transcript via hooks → messages stored; run memory-enrich → memories extracted by the real LLM + embedded; searchMemories returns by meaning; MCP `tools/list` + a `search_memories` call over HTTP with a token returns results.
- Gates: typecheck/build/test.

## Non-goals
Session summarization worker (bridget had one — defer); reranker; per-message embeddings; multi-user scoping (single-user). Full Hermes/imsg parity — focus on Claude Code transcript shape; keep `source` generic.

## Definition of done
Claude Code hooks can POST sessions/transcripts; an enrichment loop turns them into deduped, embedded, reviewable memories; memories + docs are semantically searchable; an MCP server exposes memories/docs/projects/tasks tools to agents (token-auth). Wiki `memory.md` + `mcp.md`; handover; roadmap cycle-5 → shipped.
