---
title: Memory System
status: shipped
cycle: 51
updated: 2026-07-29
---

# Memory System

Reimplements the bridget memory service in TS: ingest AI-session transcripts, enrich into durable memories, search semantically. Nothing auto-trusted — enrichment memories are `unreviewed` until the human marks them reviewed.

## Data model
- `memories` (`server/db/schema/memories.ts`): `scope` (user|agent|world), `content`, `tags[]`, `source`, `embedding halfvec(2560)`, `content_hash` (sha256), `confidence`, `evidence` jsonb, `project`, `project_id` (FK → projects; **null = global / agnostic**, cycle 23), `source_date` (last-observed, = source session `started_at`, cycle 23), `session_id`, `superseded_by` (→ the memory that replaced this one, cycle 13), `enriched_at`, `reviewed_at`, `created/updated/archived_at`. Indexes: scope, tags GIN, content trigram GIN, embedding HNSW cosine, partial-unique content_hash WHERE archived_at IS NULL. `evidence` entries (cycle 13) are `{ sessionId, msgIds, quote, reasoning, mergedAt }`.
- `memory_relations` (cycle 13, `memory-relations.ts`): `from_id`→`to_id`, `type` (supersedes|contradicts|duplicate-of), `confidence`, `status` (active|resolved), `reason`. The lineage/conflict graph; unique edge `(from,to,type)`.
- `sessions` (source, external_id unique, project, cwd, title, summary, message_count, started_at, last_active, metadata) + `messages` (session_id, role, content, external_uuid unique-per-session) + `mem_enrichment_state` (per-session enrichment progress).

## Service — `server/services/memory.ts` (+ `memory-dedup.ts`)
- `createMemory` embeds content, then **two-stage dedup** (`dedupDecision`): exact `content_hash` → skip; semantic cosine ≥ 0.85 in same scope/project → merge evidence; else insert.
- `searchMemories(q, {scope,project,tags,limit,reviewed})` — hybrid trigram + vector cosine RRF (same pattern as `searchDocs`), trigram fallback. `reviewed` (cycle 51): `true` → reviewed only, `false` → unreviewed only, `undefined` → no filter; built by the shared `reviewedCondition(reviewed?)` that `listMemories` also uses.
- `listMemories`, `getMemory`, `updateMemory` (re-embed on content change), `reviewMemory`, `archiveMemory`, `countUnreviewedMemories`.

## Two inlets into memory

Memories enter via exactly two paths, both going through `createMemory` (shared dedup via `dedupDecision` + `buildDedupCandidates`):

1. **Enrichment loop** (`enrich-memories` cron → `server/services/memory-enrich.ts`): distills concise, **confidence-scored**, **session-linked** (`sessionId` + evidence) memories from session transcripts. Auto-reviews when `confidence >= memoryAutoReviewThreshold` (~0.75). This is the primary source of agent-scoped memories.

2. **Direct `save_memory`** (MCP tool / `POST /api/memories`): saves raw content. Accepts an optional **`confidence`** (0–1) — a value ≥ 0.75 auto-reviews the memory; `null` (omitted) leaves it for manual review. `shouldAutoReview(confidence, threshold)` returns `false` for `null` — no-confidence saves always require human review. The tool description nudges callers toward ONE concise durable sentence; architecture detail belongs in handovers/wiki, not memory. Manual saves created via `POST /api/memories` (cycle 10) set `source: 'manual', reviewed: true` and skip the unreviewed state entirely.

## Ingestion — hooks (`server/api/hooks/cc/*`, `server/services/sessions.ts`)
- `POST /api/hooks/cc/[event]` upserts a session (liveness/metadata). `POST /api/hooks/cc/transcript` parses CC JSONL lines (tolerant: user/assistant text parts) → idempotent `messages`. Bearer-token auth.

## Enrichment — `server/services/memory-enrich.ts` + `enrich-memories` task (*/15)
Selects sessions with ≥4 messages and new content since last run; assembles a transcript; `chat('reasoning', ...)` with a strict atomic-memory JSON prompt; `parseMemories` (tolerant); each candidate → `createMemory` (tagged `enrichment`,`unreviewed`); records `mem_enrichment_state`. Manual: `POST /api/admin/memory-enrich-run`.

**Cycle 7 — review threshold + relevance:** `createMemory` auto-reviews when `confidence >= memoryAutoReviewThreshold` (default 0.75) — sets `reviewed_at` and strips the `unreviewed` tag; `reviewMemory` also strips `unreviewed`. Only low-confidence memories need human review. `searchMemories` attaches a `relevance` score (rank-based `1/(1+rank)`, or the optional Qwen3-Reranker at `:8883` behind `AI_RERANK_BASE_URL`, OFF by default).

**Cycle 10:** a manual **Add memory** modal (`POST /api/memories` → `createMemory({...,source:'manual',reviewed:true})`, so it's not unreviewed) + a `USelectMenu` tag filter.

**Cycle 13 — enrichment tuning + memory intelligence.** The enrichment loop was tuned and now persists via `resolveEnrichedMemory` (`memory-resolve.ts`) instead of the plain `createMemory`:
- **Tuned selector:** real-message floor ≥4 (user/assistant, content-or-thinking, excludes sidechain + `system_prompt`), a 1h grace period (don't enrich still-active sessions), growth ≥5 since last run, error-retry after 24h, and excludes only KNOWN-inactive projects (`project not in (select slug from projects where active=false)` — null/unknown projects still enrich). Bridget-quality prompt: atomic durable facts, scope guidance (`agent` most common), confidence bands (drop <0.3), and per-memory `evidence_msg_ids` + verbatim `quote` + `reasoning`. Memories inherit the session's `project`.
- **Relationship-judge** (`memory-judge.ts`): for a new candidate's cosine-near existing memories (same scope/project bucket), `chat('reasoning')` classifies each as duplicate / refines / contradicts / unrelated. Runs in **enrichment only** — manual MCP/REST saves keep the cheap `createMemory` dedup.
- **Resolution** (`resolveEnrichedMemory`): exact-hash → merge evidence; else judge → **duplicate** (merge) · **refines** → `supersede` / `review-supersede` · **contradicts** → `contradict` / `review-contradict` · else insert fresh. See the ladder below for the exact branch conditions. Conflicts ride the existing `review_queue`; `/review` resolves them (accept = archive the loser + mark the relation `resolved`; keep-both = resolve relation only).

### The resolution ladder — which action archives, and what gates it (cycle 51)

`chooseResolution(verdicts, { threshold, scope, challengerSessions, sessionsFor })`
(`server/services/memory-resolve.ts`) is pure and picks exactly one action, in this order:

| Action | Reached when | Writes | Archives the incumbent? |
|---|---|---|---|
| `duplicate` | a `duplicate` verdict ≥ 0.6 | evidence merge onto the existing row | no |
| `supersede` | `refines`, **not gated**, `confidence >= threshold` (~0.75) | new row + `memory_relations(type='supersedes')` + `archived_at`/`superseded_by` on the old row | **YES — this is the only action that does** |
| `review-supersede` | `refines`, **gated** (any confidence) OR `confidence < threshold` | new row + `supersedes` relation + a `memory-supersede` `review_queue` row | no — both stay live |
| `contradict` | `contradicts`, **not gated** | new row + `contradicts` relation + a `memory-contradict` `review_queue` row | no |
| `review-contradict` | `contradicts`, **gated** | identical writes to `contradict` | no |
| `insert` | nothing else matched | fresh row | n/a |

**The gate** (`gatedByCorroboration(existingId)`) applies to the `refines` and `contradicts`
branches only — never to `duplicate` or `insert` — and is true when either:

- **`scope === 'user'`.** Identity/preference claims are never auto-resolved: a wrong
  resolution there is self-reinforcing (the bad memory shapes later sessions, which then
  corroborate it).
- **the incumbent is out-corroborated**: `sessionsFor(existingId) >= 2 && challengerSessions <
  sessionsFor(existingId)`. `countEvidenceSessions()` counts distinct `sessionId`s in a
  memory's `evidence` jsonb (already appended per derivation by `mergeEvidence` — no schema
  change was needed). High confidence from ONE exploratory session is not evidence.

On the `refines` path the gate is checked **before** the confidence comparison, so a
user-scope or out-corroborated refinement routes to review **even at confidence 1.0** — that
ordering is the whole point and is mutation-tested. `sessionsFor` is a lookup by id rather
than a pre-computed number because the refines target and the top contradiction are routinely
different memories, so the caller cannot know which row the gate will judge; it builds a
`Map<id, count>` over the near-neighbour rows it already selected.

> Cycle 51 correction: the earlier framing that a contradiction could "silently archive" a
> memory was wrong. `contradict` has **never** archived anything — it has always inserted a
> relation + a review row. `review-contradict` is byte-identical in effect. The branch that
> archives is `supersede`, which is why the gate now covers it.

## UI — `app/pages/memories.vue`
Search (hybrid), scope filter, unreviewed toggle, cards (content/scope/tags/source). Search results show a **relevance** badge; list mode shows **confidence**. Mark reviewed (the human gate; strips the `unreviewed` chip) + Archive. **Provenance (cycle 13):** each card surfaces its source-session link, the verbatim `quote` + `reasoning` from its evidence, and relation badges (→ supersedes / ← superseded-by / ⚠ contradicts). `/review` renders memory-conflict items (New vs Existing + Accept / Keep-both). Sidebar "Memory" nav with unreviewed badge. **Cycle 24:** cards show the **source date** (`sourceDate ?? createdAt`, so imported history reads backdated, not "today") + a **project** badge, with a **project filter** (`USelectMenu`) alongside scope/tags.

> The 457 imported bridget sessions (cycle 13 phase 3) feed this enrichment locally — no bridget memories were imported; they're regenerated here with provenance + the relationship graph.

**Cycle 23 — project association.** Enrichment now sets `project_id` **by scope**: `agent` memories inherit their source session's project, `user`/`world` memories stay `null` (global). `source_date` = the source session's `started_at`, advanced via SQL `greatest` when new evidence merges. The selector excludes sessions whose project is `active=false`. See [projects.md](projects.md).

**Cycle 24 — enrichment quality v2 (the cycle-13 prompt over-extracted ephemeral noise: test counts, the AI's own skills/workflow, transient bugs — and inflated confidence so the floor caught nothing).** The `SYSTEM_PROMPT` is now ruthlessly selective ("most sessions yield 0–3; an empty list is a correct answer"), with an explicit **reject list** (test counts, build/CI status, "current/now X", in-progress bugs, the AI's own skills/workflow, session narration, file paths/SHAs/in-flux versions) and **confidence re-anchored to DURABILITY, not observability** (a precisely-observed but ephemeral fact = LOW confidence). The `parseMemories` floor is **0.6** (was 0.3). Prod's first ~308 cycle-13-prompt memories were cleared + re-enriched under v2 — see the [prod-rollout handover](../handovers/2026-06-16-prod-rollout-and-memory-quality.md).

**Cycle 51 — agent-facing recall excludes unreviewed memories by default.** The `unreviewed`
state only ever gated the human UI; every agent read path saw raw enrichment output as
established fact. All three agent recall paths now filter it out:

- **`search_memories`** and **`get_recent_memories`** (MCP + in-process agent tools) pass
  `reviewed: true` unless the caller sets **`includeUnreviewed: true`** — an explicit opt-in,
  useful when triaging the queue itself.
- **The automatic per-turn injection** (`buildMemoryContext`, `server/lib/agent/context.ts`)
  calls `searchMemories(q, { limit: 5, reviewed: true })`. This one fires on **every** voice
  turn (`server/api/voice/ws.ts`) with no agent decision behind it, so it has **no opt-out** —
  the `includeUnreviewed` flag covers only tools an agent explicitly chooses to call, and this
  path bypasses them entirely.

The web surface is deliberately **unchanged**: `/memories` and its REST endpoints still show
unreviewed rows (that page exists to review them), and `listMemories`' `reviewed` option keeps
its previous default of "no filter".

See [mcp.md](mcp.md) for the agent-facing tools.
