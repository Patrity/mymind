---
title: Memory System
status: shipped
cycle: 5
updated: 2026-06-03
---

# Memory System

Reimplements the bridget memory service in TS: ingest AI-session transcripts, enrich into durable memories, search semantically. Nothing auto-trusted — enrichment memories are `unreviewed` until the human marks them reviewed.

## Data model
- `memories` (`server/db/schema/memories.ts`): `scope` (user|agent|world), `content`, `tags[]`, `source`, `embedding halfvec(2560)`, `content_hash` (sha256), `confidence`, `evidence` jsonb (merge trail), `project`, `session_id`, `enriched_at`, `reviewed_at`, `created/updated/archived_at`. Indexes: scope, tags GIN, content trigram GIN, embedding HNSW cosine, partial-unique content_hash WHERE archived_at IS NULL.
- `sessions` (source, external_id unique, project, cwd, title, summary, message_count, started_at, last_active, metadata) + `messages` (session_id, role, content, external_uuid unique-per-session) + `mem_enrichment_state` (per-session enrichment progress).

## Service — `server/services/memory.ts` (+ `memory-dedup.ts`)
- `createMemory` embeds content, then **two-stage dedup** (`dedupDecision`): exact `content_hash` → skip; semantic cosine ≥ 0.85 in same scope/project → merge evidence; else insert.
- `searchMemories(q, {scope,project,tags,limit})` — hybrid trigram + vector cosine RRF (same pattern as `searchDocs`), trigram fallback.
- `listMemories`, `getMemory`, `updateMemory` (re-embed on content change), `reviewMemory`, `archiveMemory`, `countUnreviewedMemories`.

## Ingestion — hooks (`server/api/hooks/cc/*`, `server/services/sessions.ts`)
- `POST /api/hooks/cc/[event]` upserts a session (liveness/metadata). `POST /api/hooks/cc/transcript` parses CC JSONL lines (tolerant: user/assistant text parts) → idempotent `messages`. Bearer-token auth.

## Enrichment — `server/services/memory-enrich.ts` + `enrich-memories` task (*/15)
Selects sessions with ≥4 messages and new content since last run; assembles a transcript; `chat('reasoning', ...)` with a strict atomic-memory JSON prompt; `parseMemories` (tolerant); each candidate → `createMemory` (tagged `enrichment`,`unreviewed`); records `mem_enrichment_state`. Manual: `POST /api/admin/memory-enrich-run`.

## UI — `app/pages/memories.vue`
Search (hybrid), scope filter, unreviewed toggle, cards (content/scope/tags/confidence/source), Mark reviewed (the human gate) + Archive. Sidebar "Memory" nav with unreviewed badge.

See [mcp.md](mcp.md) for the agent-facing tools.
