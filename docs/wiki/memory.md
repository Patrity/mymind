---
title: Memory System
status: shipped
cycle: 5
updated: 2026-06-16
---

# Memory System

Reimplements the bridget memory service in TS: ingest AI-session transcripts, enrich into durable memories, search semantically. Nothing auto-trusted — enrichment memories are `unreviewed` until the human marks them reviewed.

## Data model
- `memories` (`server/db/schema/memories.ts`): `scope` (user|agent|world), `content`, `tags[]`, `source`, `embedding halfvec(2560)`, `content_hash` (sha256), `confidence`, `evidence` jsonb, `project`, `session_id`, `superseded_by` (→ the memory that replaced this one, cycle 13), `enriched_at`, `reviewed_at`, `created/updated/archived_at`. Indexes: scope, tags GIN, content trigram GIN, embedding HNSW cosine, partial-unique content_hash WHERE archived_at IS NULL. `evidence` entries (cycle 13) are `{ sessionId, msgIds, quote, reasoning, mergedAt }`.
- `memory_relations` (cycle 13, `memory-relations.ts`): `from_id`→`to_id`, `type` (supersedes|contradicts|duplicate-of), `confidence`, `status` (active|resolved), `reason`. The lineage/conflict graph; unique edge `(from,to,type)`.
- `sessions` (source, external_id unique, project, cwd, title, summary, message_count, started_at, last_active, metadata) + `messages` (session_id, role, content, external_uuid unique-per-session) + `mem_enrichment_state` (per-session enrichment progress).

## Service — `server/services/memory.ts` (+ `memory-dedup.ts`)
- `createMemory` embeds content, then **two-stage dedup** (`dedupDecision`): exact `content_hash` → skip; semantic cosine ≥ 0.85 in same scope/project → merge evidence; else insert.
- `searchMemories(q, {scope,project,tags,limit})` — hybrid trigram + vector cosine RRF (same pattern as `searchDocs`), trigram fallback.
- `listMemories`, `getMemory`, `updateMemory` (re-embed on content change), `reviewMemory`, `archiveMemory`, `countUnreviewedMemories`.

## Ingestion — hooks (`server/api/hooks/cc/*`, `server/services/sessions.ts`)
- `POST /api/hooks/cc/[event]` upserts a session (liveness/metadata). `POST /api/hooks/cc/transcript` parses CC JSONL lines (tolerant: user/assistant text parts) → idempotent `messages`. Bearer-token auth.

## Enrichment — `server/services/memory-enrich.ts` + `enrich-memories` task (*/15)
Selects sessions with ≥4 messages and new content since last run; assembles a transcript; `chat('reasoning', ...)` with a strict atomic-memory JSON prompt; `parseMemories` (tolerant); each candidate → `createMemory` (tagged `enrichment`,`unreviewed`); records `mem_enrichment_state`. Manual: `POST /api/admin/memory-enrich-run`.

**Cycle 7 — review threshold + relevance:** `createMemory` auto-reviews when `confidence >= memoryAutoReviewThreshold` (default 0.75) — sets `reviewed_at` and strips the `unreviewed` tag; `reviewMemory` also strips `unreviewed`. Only low-confidence memories need human review. `searchMemories` attaches a `relevance` score (rank-based `1/(1+rank)`, or the optional Qwen3-Reranker at `:8883` behind `AI_RERANK_BASE_URL`, OFF by default).

**Cycle 10:** a manual **Add memory** modal (`POST /api/memories` → `createMemory({...,source:'manual',reviewed:true})`, so it's not unreviewed) + a `USelectMenu` tag filter.

**Cycle 13 — enrichment tuning + memory intelligence.** The enrichment loop was tuned and now persists via `resolveEnrichedMemory` (`memory-resolve.ts`) instead of the plain `createMemory`:
- **Tuned selector:** real-message floor ≥4 (user/assistant, content-or-thinking, excludes sidechain + `system_prompt`), a 1h grace period (don't enrich still-active sessions), growth ≥5 since last run, error-retry after 24h, and excludes only KNOWN-inactive projects (`project not in (select slug from projects where active=false)` — null/unknown projects still enrich). Bridget-quality prompt: atomic durable facts, scope guidance (`agent` most common), confidence bands (drop <0.3), and per-memory `evidence_msg_ids` + verbatim `quote` + `reasoning`. Memories inherit the session's `project`.
- **Relationship-judge** (`memory-judge.ts`): for a new candidate's cosine-near existing memories (same scope/project bucket), `chat('reasoning')` classifies each as duplicate / refines / contradicts / unrelated. Runs in **enrichment only** — manual MCP/REST saves keep the cheap `createMemory` dedup.
- **Resolution** (`resolveEnrichedMemory`): exact-hash → merge evidence; else judge → **duplicate** (merge) · **refines** ≥ threshold → **auto-supersede** (insert new, archive old with `superseded_by`, `memory_relations(type='supersedes')`) · refines < threshold → insert + a `memory-supersede` **review item** · **contradicts** → insert + `memory_relations(type='contradicts')` + a `memory-contradict` review item · else insert fresh. Conflicts ride the existing `review_queue`; `/review` resolves them (accept = archive the loser + mark the relation `resolved`; keep-both = resolve relation only).

## UI — `app/pages/memories.vue`
Search (hybrid), scope filter, unreviewed toggle, cards (content/scope/tags/source). Search results show a **relevance** badge; list mode shows **confidence**. Mark reviewed (the human gate; strips the `unreviewed` chip) + Archive. **Provenance (cycle 13):** each card surfaces its source-session link, the verbatim `quote` + `reasoning` from its evidence, and relation badges (→ supersedes / ← superseded-by / ⚠ contradicts). `/review` renders memory-conflict items (New vs Existing + Accept / Keep-both). Sidebar "Memory" nav with unreviewed badge.

> The 457 imported bridget sessions (cycle 13 phase 3) feed this enrichment locally — no bridget memories were imported; they're regenerated here with provenance + the relationship graph.

See [mcp.md](mcp.md) for the agent-facing tools.
