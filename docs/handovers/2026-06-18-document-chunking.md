---
title: Document Chunking + Contextual Retrieval — the RAG-pipeline fix
cycle: 31
date: 2026-06-18
status: shipped
branch: feat/document-chunking-impl
spec: ../superpowers/specs/2026-06-17-document-chunking-contextual-retrieval-design.md
plans:
  - ../superpowers/plans/2026-06-17-document-chunking-contextual-retrieval.md
wiki:
  - ../wiki/chunking.md
  - ../wiki/search.md
shipped:
  - "**`chunks` table** (`server/db/schema/chunks.ts`, migration `0023_sticky_ego.sql`) — generic 1-row-per-chunk index keyed `(source_type, source_id, ord)`, with `content` (passage), `context` (LLM situating sentence), `heading_path`, `token_count`, `char_start/end`, `embedding halfvec(2560)` + HNSW cosine `chunks_embedding_hnsw`, `embedded_text_hash`. Added `documents.chunked_hash` (re-chunk gate). Legacy `documents.embedding`/`embedded_hash` now dead (kept nullable for rollback)."
  - "**Pure markdown chunker** (`server/lib/chunking/chunk-markdown.ts`, TDD, 9 tests) — heading-hierarchy split (fence-aware), recursive paragraph→sentence→word fallback for oversized sections, atomic code fences/tables, ~300-tok target / 512 cap / ~10% overlap on recursive splits only, char-based token estimate, monotonic `char_start/end`."
  - "**Contextualization** (`server/lib/chunking/contextualize.ts`, 3 tests) — `contextualizeChunk()` asks the `bulk` model for a one-sentence situating context (Anthropic-style); **resilient** (failure/empty → `heading_path` fallback, never blocks embedding); flag-gated."
  - "**`chunkAndEmbedSource`** (`server/lib/chunking/embed-source.ts`) — chunk → contextualize (sequential, prefix-cache-friendly) → embed `context + content` in `embedBatch` batches → transactional delete-then-insert of the source's chunk rows. Throws on vector-count mismatch (no silent NULL embeddings)."
  - "**`runEmbedding` rewrite** (`server/services/embedding.ts`) — re-chunks live docs where `chunked_hash IS DISTINCT FROM content_hash`; per-doc failure isolation (16k whole-doc failure mode gone); `publishChange` per doc. Cron `embed-documents` + admin `embed-run` unchanged."
  - "**Chunk-aware search** (`server/services/documents.ts`) — `searchDocs` vector lane now queries `chunks` (top-100 → best-chunk-per-doc collapse via `server/lib/chunking/collapse.ts`) then RRF-fuses with the unchanged trigram lane; **contract preserved** (`DocumentDTO[]`, soft-deletes excluded via join). New **`searchPassages(q,{project?,limit?})` → `ChunkHit[]`** (`shared/types/documents.ts`) for chunk-level RAG context."
  - "**MCP `search_passages` tool** (`server/lib/agent/tools.ts`; registry 17→18, `agent-tools.test.ts` updated) — chunk-level passages with parent doc title/path for agents."
  - "**Long image OCR** (`server/services/image-enrich.ts`) — OCR >512 tok routed through the primitive (`source_type='image'`); short/shrunk OCR clears stale chunks; `searchImages` (`server/services/images.ts`) fuses a third OCR-chunk RRF lane, reusing the single query embedding."
  - "Built subagent-driven (Tasks 2-11 + final whole-branch review). Final review: **SHIP-WITH-NITS** — the flagged image-orphan-chunk-on-shrink + embed count guard + hardSplit overlap clamp were fixed (`be800bd`). Gates: **typecheck 0 / test 428 / build / migrate 0023**."
---

# Document Chunking + Contextual Retrieval (cycle 31)

Fixes the RAG pipeline's foundational defect: documents were embedded **whole** (`server/services/embedding.ts:20` sent `title + content` straight to TEI `/embed`). TEI is configured to a **16k-token** input limit, so larger docs threw, were marked "poison," never embedded, and were **invisible to semantic search forever**; smaller docs embedded poorly (one last-token-pooled vector over thousands of tokens). Now every document (and long image OCR) is split into ~300-token contextualized chunks. Full behaviour: [wiki/chunking.md](../wiki/chunking.md).

## How it was built
Brainstorm → spec → plan → subagent-driven build, in an isolated git worktree (`.claude/worktrees/document-chunking`, branch `feat/document-chunking-impl`). Decisions (all user-approved): two retrieval paths over one chunk index (collapsed docs + chunk passages); scope = documents + long image OCR (memories excluded, YAGNI); structure-aware splitting; **LLM contextual retrieval now** (not a templated-prefix stopgap). Defaults (chunk size ~300 / low overlap) were set from fact-checked research — Chroma's chunk-size eval (200–400 tok sweet spot, low overlap) + Anthropic Contextual Retrieval (35/49/67% fewer retrieval failures); late chunking was excluded as infeasible on TEI.

## Task 1 spike (rig limits)
- **TEI max input = 16k tokens** (user-confirmed) — the source of the original failures.
- `embedBatch` default **32** (safe vs typical TEI `max_client_batch_size`; lower it in the `chunking` settings key if the rig rejects a batch).
- **Prefix caching unverified** on the rig. Mitigation in place: chunks of a doc are contextualized **consecutively** so a prefix-caching server (vLLM/SGLang) reuses the doc prefix; if it doesn't cache, backfill is just slower (local compute, no $). If contextual backfill is too slow, set `chunking.contextual=false` for the initial pass and re-enable later.

## Pending acceptance (NOT done yet — be honest)
- **Live E2E with the rigs has NOT been run.** Gates (typecheck/test/build/migrate) are green and the branch passed a final whole-branch review, but the real-app validation — create a >16k-token markdown doc → run `embed-run` → semantic search finds it → `search_passages` returns the passage — needs the embeddings + `bulk` rigs up + a dev server. Do this before declaring the cycle accepted (per project rules, with `playwright-cli`).
- **Not merged to `master`.** Merge via `finishing-a-development-branch` after live E2E. `master` auto-deploys (CI), so the corpus re-chunk backfill runs post-deploy via the `embed-documents` cron (`chunked_hash` starts null). Watch the first runs (contextualization is an LLM call per chunk).
- **Branch consolidation note:** the work lives on `feat/document-chunking-impl`. `feat/document-chunking` holds the spec+plan checkpoint plus one stray Task-3 commit (`35b0c19`) that landed there when a subagent escaped the worktree (subagents default to the main repo root, not the `EnterWorktree` cwd — that commit was cherry-picked into impl as `8749bab`). When merging, take `feat/document-chunking-impl` as the source of truth and discard/replace `feat/document-chunking`. See the `parallel-sessions-share-git-head` memory.

## Deferred follow-ons (documented, not this cycle)
- **Contextual BM25** over chunk text → Anthropic's ~49% (today only the embedding lane is contextual).
- Enable the wired-but-off **reranker** (`:8883`) on passage results → ~67%.
- **Chunk GC on hard-delete** (search already excludes soft-deleted via the join; orphan rows are storage bloat only).
- Widen pre-collapse recall (`DISTINCT ON (source_id)` / larger candidate budget) if many-chunk docs crowd the 100-row vector budget.
- Drop the dead `documents.embedding` / `embedded_hash` columns; real Qwen tokenizer if exact sizing ever matters.

## Cycle numbering
This is **cycle 31**. Cycle 30 was claimed by the parallel **exec-gate (Cycle B2)** work on `feat/exec-gate` — renamed this cycle 30→31 to avoid the collision.
