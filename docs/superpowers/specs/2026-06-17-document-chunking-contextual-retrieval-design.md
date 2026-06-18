---
title: Document Chunking + Contextual Retrieval (Cycle 31)
date: 2026-06-17
status: design
cycle: 31
related:
  - 2026-06-03-ai-enrichment.md
  - 2026-06-11-image-pipeline-design.md
  - 2026-06-10-ai-config-registry-design.md
  - 2026-06-17-web-research-b1-design.md
  - ../../wiki/search.md
---

# Document Chunking + Contextual Retrieval (Cycle 31)

Fixes a foundational defect in the RAG pipeline: **documents are embedded whole**, with no
chunking and no truncation. Documents over TEI's configured 16k-token input limit fail to
embed entirely and fall out of semantic search permanently; documents under the limit embed
*badly* (a single 2560-dim vector cannot represent thousands of tokens). This cycle introduces
a shared **chunking primitive** with **LLM contextual retrieval**, reworks the embedding worker
and document search, and wires long image OCR into the same primitive.

## Problem (current state — verified in code)

The embedding worker sends the entire document body to the embeddings endpoint with no size
handling:

- `server/services/embedding.ts:20` builds the embed input as `` `${title}\n\n${content}` `` —
  the full document, no truncation, no chunking.
- `server/lib/ai/embeddings.ts:29-39` POSTs that straight to TEI `/embed`. The rig's TEI is
  configured to a **16k-token** max input length, so any document exceeding it throws.
- The batch `try/catch` (`embedding.ts:22-26`) swallows the failure and falls back to per-doc
  embedding (`:38-51`); the oversized doc throws again, is logged as a "poison doc"
  (`:48`), increments `failed`, and is **never embedded**. Because `embedded_hash` never
  updates, every subsequent cron run re-attempts and re-fails it — wasted compute on every tick.
- `searchDocs` (`server/services/documents.ts:151-193`) only pulls vector candidates
  `WHERE embedding IS NOT NULL` (`:172`). Failed docs are therefore **invisible to semantic
  search** and silently degrade to trigram-only.

Net effect: the largest, most substantial documents — the ones most worth retrieving — are
exactly the ones excluded from the vector index. Even documents that *do* embed are diluted:
qwen3-embedding uses **last-token pooling**, so a single vector over thousands of tokens is
dominated by the tail and washes out specific content.

This is not a model or fit problem — qwen3-embedding-4b natively supports 32k context. It is a
**pipeline design** problem: we never chunked.

## Research summary (web, fact-checked)

A `deep-research` fan-out (21 sources, 103 claims extracted, 25 adversarially verified) plus
direct reads of the two most rigorous primary sources. The synthesis stage of the harness
returned malformed output; findings below come from the surviving verified-refutation set and
direct source fetches.

**Established directionally (informs our defaults):**
- **Chunk size sweet spot is 200–400 tokens, not 512+.** Chroma's empirical evaluation
  (token-level IoU/recall/precision) found RecursiveCharacterTextSplitter @ ~200 tokens and
  ClusterSemanticChunker @ ~200 tokens best. Precision cliff: 200-tok chunks ≈ **7.0% precision /
  88.1% recall**; 800-tok chunks ≈ **1.5% precision / 85.4% recall** — comparable recall, ~5×
  the precision, purely from smaller chunks. (https://www.trychroma.com/research/evaluating-chunking)
- **Overlap should be low/zero.** Overlap buys marginal recall at a steep precision cost. We
  lean low and apply it only where we *must* split a coherent unit.
- **Recursive splitting with structure-aware separators beats fixed-size splitting** (direction
  confirmed; the specific "+9%" magnitude did not survive verification).
- **LLM contextual retrieval materially improves retrieval.** Anthropic's Contextual Retrieval
  prepends an LLM-generated, chunk-specific situating sentence (~50–100 tokens) before embedding:
  **35%** fewer retrieval failures (contextual embeddings alone), **49%** with contextual BM25,
  **67%** with reranking added. Critically, they tested **generic** document-summary/context
  prefixes and saw **"very limited gains"** — only *chunk-specific LLM* context delivers the win.
  (https://www.anthropic.com/news/contextual-retrieval)

**Refuted / not reliably replicable (we do NOT depend on these):**
- "Structure-aware beats naive by ~9% / 0.919 recall" (1 confirm / 2 refute).
- "Recursive 100-token, 0% overlap is universally best" (0/3).
- "Non-overlapping is optimal / >20% overlap always hurts" (0/3).
- **Late chunking's** large MTEB gains (0/3, multiple). Independently, late chunking is
  **architecturally infeasible** on our stack: TEI exposes only pooled vectors (no token-level
  embeddings) and the 16k cap blocks full-document encoding for large docs. Excluded.

**Meta-lesson:** chunking is empirical and corpus-dependent; specific benchmark numbers do not
transfer. The design therefore commits to **sane, evidence-aligned defaults that are tunable**,
not to any single paper's prescription.

## Locked decisions (from brainstorm)

1. **Two retrieval paths over one chunk index** — `searchDocs` stays doc-shaped (collapsed
   best-chunk-per-doc) for the command palette and existing MCP; a new `searchPassages` returns
   chunk-level passages with parent refs for the in-app agent and a new MCP `search_passages`.
2. **Scope: documents + long image OCR** through one shared primitive. Memories excluded (they
   are concise single-fact records by design — chunking them is YAGNI).
3. **Structure-aware splitting** (heading hierarchy → recursive fallback), code/tables atomic.
4. **Chunk size ~300 tokens (range 200–400), ~512 ceiling; ~10% overlap, recursive-splits only.**
5. **LLM contextual retrieval now** (not a templated-prefix-only stopgap) — the full 35%+ win.

## Architecture

### 1. `chunks` table (migration — additive)

```
chunks
  id                 uuid pk default gen_random_uuid()
  source_type        text not null         -- 'document' | 'image'
  source_id          uuid not null         -- documents.id | images.id
  ord                int  not null          -- 0-based order within source
  content            text not null          -- raw chunk text; THIS is the returned passage
  context            text                   -- LLM-generated situating sentence (nullable)
  heading_path       text                   -- 'Title › H1 › H2' breadcrumb (provenance + fallback)
  token_count        int
  char_start         int
  char_end           int
  embedding          halfvec(2560)
  embedded_text_hash text                   -- sha256 of the exact text embedded (context+content)
  created_at         timestamptz not null default now()

  unique (source_type, source_id, ord)
  index (source_type, source_id)
  hnsw (embedding halfvec_cosine_ops)
```

On `documents`: add `chunked_hash text` (the `content_hash` last chunked+embedded — the
re-chunk gate, replacing the per-doc `embedded_hash` semantics). Keep `documents.embedding`
nullable but **unused** (cheap rollback insurance; dropped in a later cleanup). On `images`:
keep `images.embedding` (summary embedding) as-is.

No FK constraints on `chunks.source_id` (heterogeneous source, mirrors the existing
denormalized-reference style in the schema); orphan chunks are swept by the worker (delete
chunks whose source is gone/soft-deleted).

### 2. Chunking service (pure — `server/lib/chunking/`)

`chunkMarkdown(text, opts): Chunk[]` — no DB, no AI, fully unit-tested. Deterministic.

- **Heading split:** parse markdown heading hierarchy (H1→H6) into sections; each carries its
  breadcrumb `heading_path` (`Doc Title › H1 › H2 …`).
- **Recursive fallback:** a section over the token cap is split on a separator priority list
  `["\n\n", "\n", sentence (`. ? !`), " ", ""]`, each piece ≤ cap, with ~10% overlap **between
  recursive sub-pieces only** (heading-boundary chunks get no overlap — they are already
  semantic units).
- **Atomic blocks:** fenced code (```` ``` ````) and tables (pipe rows) are kept intact when
  they fit. A code fence that alone exceeds the cap is split on line boundaries only (never
  mid-line). A split table repeats its header row on each part.
- **Sizing:** target ~300 tokens, ceiling ~512. Token count via a char-based estimate
  (~3.8 chars/token) — zero-dependency and deterministic; chunk *sizing* tolerance is wide and
  the contextualization step dominates quality, so a real Qwen tokenizer is not warranted now.
- **Output:** `{ ord, content, headingPath, charStart, charEnd, tokenCount }[]`. A doc with no
  headings → recursive-only. A short doc → a single chunk.

### 3. Contextualization step (`server/lib/chunking/contextualize.ts`)

For each chunk, generate a chunk-specific situating sentence via the registry **`bulk`** usage:

- Prompt: the whole source document + the chunk, instruction to "give a short (1 sentence)
  context situating this chunk within the document, for search retrieval." Output stored in
  `chunks.context` and prepended for embedding: `embedText = context + "\n\n" + content`.
- **Resilient:** if the model call fails or returns empty, fall back to
  `embedText = heading_path + "\n\n" + content` (and leave `context` null). Context generation
  **never blocks** embedding — a context failure degrades to the deterministic breadcrumb, not
  to an unembedded doc.
- **Flag-gated:** a config flag `contextual_chunks` (default on) toggles the LLM step; off →
  breadcrumb prefix only. Lets us disable cheaply if the rig is overloaded.

### 4. Prompt-caching de-risk

Contextual retrieval sends the whole document once per chunk. To avoid re-paying that:

- The worker processes **all chunks of a single document consecutively**, so the shared
  document prefix stays hot. Most local inference servers (vLLM / SGLang) perform **automatic
  prefix caching**, which gives us Anthropic's cache benefit for free.
- **If the rig does not cache, it still works** — just slower, and it is local compute (no $).
- **Early implementation check (first task):** confirm the rig's prefix-caching behaviour and
  measure per-chunk latency on a representative doc before kicking off the full backfill. If
  latency is prohibitive and caching is absent, fall back to breadcrumb-only for the initial
  backfill and contextualize incrementally.

### 5. Embedding worker rework (`runEmbedding`)

Replaces the current whole-doc logic (`server/services/embedding.ts`):

1. Select live documents where `chunked_hash IS DISTINCT FROM content_hash` (batch-limited).
2. Per document: `chunkMarkdown(title + "\n\n" + content)` → contextualize chunks →
   batch-embed the prefixed texts (`embed()`, ≤ TEI max batch per request).
3. In a transaction: `DELETE FROM chunks WHERE source_type='document' AND source_id=:id`,
   insert the new chunk rows (with `embedding`, `context`, `heading_path`, `embedded_text_hash`),
   then `UPDATE documents SET chunked_hash = content_hash`.
4. `publishChange({ resource: 'document', action: 'updated', id })` after commit (preserves
   live-reactivity — see `.claude/rules/live-data.md`).
5. **Poison isolation retained:** a doc that fails to embed leaves `chunked_hash` stale and is
   retried next run — but the 16k failure mode is gone (chunks are ≤512 tokens).

The cron task `embed-documents` and the admin `embed-run` route call the reworked worker
unchanged.

### 6. Search rework (`server/services/documents.ts`)

**`searchDocs(q, opts) → DocumentDTO[]` (signature unchanged):**
- Trigram lane: unchanged (`ILIKE` + `similarity()` over `documents.content`/`title`).
- Vector lane: embed query → cosine over `chunks` (`source_type='document'`, project-filtered
  via join to `documents`) → top ~100 chunk hits → **collapse to best (min-distance) chunk per
  `source_id`** → top 50 doc ids.
- RRF-fuse the two doc-id lanes (`rrfFuse`), hydrate `DocumentDTO[]`. The palette + existing
  MCP `search_docs` keep working — with real recall now.

**`searchPassages(q, opts) → ChunkHit[]` (new):** returns
`{ sourceType, sourceId, ord, content, headingPath, context, score, docTitle, docPath }`, top-K
chunk passages, with **optional neighbour expansion** (include `ord±1` for surrounding context).
Powers the in-app agent's RAG context and a new MCP tool `search_passages`.

### 7. Image OCR integration

In `server/services/image-enrich.ts`: after OCR, if the OCR token estimate exceeds one chunk's
worth, route `ocrText` through `chunkMarkdown` + contextualize + embed with
`source_type='image'`, `source_id=image.id`. Keep the existing **summary** embedding on
`images.embedding` (good for "what is this image about"). `searchImages` vector lane fuses
summary-embedding hits + OCR-chunk hits (collapse chunks → image). **Short OCR stays
summary-only** (no chunk rows).

### 8. Backfill & prod safety

- Migration is **additive** — no destructive change to existing columns.
- Backfill is **automatic**: `chunked_hash` starts null ⇒ `IS DISTINCT FROM content_hash` ⇒ the
  `embed-documents` cron re-chunks the entire corpus over successive rate-limited batches.
  `embed-run` admin route for on-demand. Image backfill mirrors via the image pipeline's
  backfill path.
- **No regression during backfill:** un-chunked docs simply stay trigram-only (exactly today's
  behaviour for unembedded docs); trigram lane is unaffected.
- Ship on `feat/document-chunking` off `master`; gates green (typecheck / test / build /
  migrate) → merge → cron backfills post-deploy. CI auto-deploys `master` (memory:
  do-not-push-master-mid-flight) — code changes here are not docs-only, so they DO trigger CI.

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `lib/chunking/chunk-markdown.ts` | Pure markdown → `Chunk[]` | nothing (pure) |
| `lib/chunking/contextualize.ts` | Chunk → situating sentence (resilient, flag-gated) | `bulk` model via registry |
| `services/embedding.ts` (`runEmbedding`) | Orchestrate chunk → contextualize → embed → upsert | chunking, contextualize, `embed()`, db |
| `services/documents.ts` (`searchDocs`/`searchPassages`) | Chunk-aware retrieval (collapsed + passages) | `chunks`, `embedOne`, `rrfFuse` |
| `services/image-enrich.ts` | Route long OCR through the primitive | chunking, contextualize, `embed()` |
| MCP `search_passages` | Expose passage retrieval to agents | `searchPassages` |

## Testing

- **TDD, pure chunker:** heading split; oversized-section recursion; atomic code fence; atomic
  table + header repeat on split; overlap correctness (recursive only); no-heading doc;
  short/empty doc → single/zero chunks; breadcrumb correctness.
- **Unit:** chunk→doc collapse + RRF ordering; `embedded_text_hash` stability.
- **Unit:** contextualizer with a **mocked** model — success path, failure → breadcrumb
  fallback, flag-off path.
- **Integration:** embed a known multi-section doc → expected chunk count + rows; `searchDocs`
  returns it (collapsed); `searchPassages` returns the right passage with parent refs.
- **E2E (playwright-cli, per project rules):** create a large (>16k-token) markdown doc → run
  embed → semantic search finds it → agent/MCP `search_passages` returns a relevant passage.
  Proves the original failure mode is fixed end-to-end.

## Success criteria

1. A >16k-token markdown doc embeds successfully (as chunks) and is retrievable by semantic
   search — the original failure mode is gone.
2. No "poison doc" embedding failures remain for oversized docs; the cron stops thrashing.
3. `searchDocs` contract unchanged; palette + existing MCP unaffected.
4. `searchPassages` + MCP `search_passages` return chunk-level passages with parent refs.
5. Long image OCR is semantically searchable; short OCR unchanged.
6. Gates green (typecheck / test / build / migrate); E2E PASS.

## Documented follow-ons (NOT this cycle)

- **Contextual BM25** over chunk text (trigram lane on contextualized chunks) → Anthropic's 49%.
- **Enable the wired-but-off reranker** (`Qwen3-Reranker-0.6B`, `:8883`) on passage results →
  Anthropic's 67%. (Already tracked: mymind task "Scoped memory depth — reranker …".)
- Drop the dead `documents.embedding` column.
- Real Qwen tokenizer for exact sizing, if chunk-size precision ever proves to matter.

## Open items / risks

- **Prompt-caching feasibility** on the local rig (mitigated by §4: doc-consecutive ordering,
  works-but-slower without caching, breadcrumb fallback for backfill).
- **Backfill duration** — one-time, batched, rate-limited; runs on the cron post-deploy.
- **TEI max batch size** — confirm the per-request batch limit before tuning the embed batch.
