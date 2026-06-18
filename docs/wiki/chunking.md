---
title: Document Chunking + Contextual Retrieval
status: shipped
cycle: 31
updated: 2026-06-18
---

# Document Chunking + Contextual Retrieval

How documents (and long image OCR) are split, contextualized, embedded, and retrieved. Replaced the old "embed the whole document as one vector" pipeline, which silently dropped docs over TEI's 16k-token input limit out of semantic search entirely and diluted everything else.

## The shared `chunks` primitive
One generic table, 1-row-per-chunk, used by any text-bearing source:

`chunks` (`server/db/schema/chunks.ts`, migration `0023_sticky_ego.sql`):
| column | note |
|---|---|
| `source_type` | `'document' \| 'image'` |
| `source_id` | the document/image id (no FK — heterogeneous) |
| `ord` | 0-based order within the source |
| `content` | the chunk's raw text — **this is the returned passage** |
| `context` | LLM-generated situating sentence (nullable; null when contextualization is off/failed) |
| `heading_path` | `Title › H1 › H2` breadcrumb (provenance + the fallback prefix) |
| `token_count`, `char_start`, `char_end` | sizing + source offsets |
| `embedding` | `halfvec(2560)`, HNSW cosine index `chunks_embedding_hnsw` |
| `embedded_text_hash` | sha256 of the exact text embedded (`context + "\n\n" + content`) |

Indexes: `unique(source_type, source_id, ord)`, btree `(source_type, source_id)`, HNSW on `embedding`. `documents.chunked_hash` records the `content_hash` last chunked (the re-chunk gate). The legacy `documents.embedding` / `documents.embedded_hash` columns are now **dead** (kept nullable for rollback; drop in a later cleanup).

## The pipeline (write path)
1. **Chunker** — `server/lib/chunking/chunk-markdown.ts` (pure, deterministic, unit-tested). `chunkMarkdown(text, opts)` splits on markdown heading hierarchy (fence-aware: `#` inside ``` is not a heading); oversized sections fall back to recursive paragraph→sentence→word splitting; fenced code blocks and tables stay atomic when they fit. ~300-token target, 512 hard cap, ~10% overlap **only on recursive sub-splits**. Char-based token estimate (~3.8 chars/tok). Emits sequential `ord` + monotonic `char_start/end`.
2. **Contextualize** — `server/lib/chunking/contextualize.ts`. `contextualizeChunk()` asks the `bulk` model for a one-sentence situating context per chunk (Anthropic-style contextual retrieval). **Resilient**: a model failure or empty reply falls back to the `heading_path` breadcrumb — context generation never blocks embedding. Flag-gated via `getChunkingConfig().contextual`.
3. **Embed + upsert** — `server/lib/chunking/embed-source.ts`. `chunkAndEmbedSource({sourceType, sourceId, title, body})` chunks → contextualizes each chunk sequentially (keeps the doc prefix warm for prefix-caching inference servers) → embeds `context + "\n\n" + content` in `embedBatch`-sized batches → in one transaction deletes the source's old chunk rows and inserts the new ones. Throws if the provider under-returns vectors (no silent NULL embeddings).
4. **Worker** — `server/services/embedding.ts` `runEmbedding()` (cron `embed-documents`, `*/5`). Selects live docs where `chunked_hash IS DISTINCT FROM content_hash`, calls `chunkAndEmbedSource` per doc, sets `chunked_hash`, `publishChange` per doc. Per-doc failure isolation (a bad doc is retried next run; the 16k failure mode is gone since chunks are ≤512 tok).

## Retrieval (read path)
`server/services/documents.ts`:
- **`searchDocs(q)` → `DocumentDTO[]`** (contract unchanged). Trigram lane unchanged; the **vector lane now queries `chunks`** (`source_type='document'`, joined to live docs, project-filtered), takes the top 100 chunk hits by cosine distance, and **collapses to best-chunk-per-doc** (`server/lib/chunking/collapse.ts` `collapseChunksToSources`) before RRF-fusing with trigram. Soft-deleted docs are excluded via the join.
- **`searchPassages(q, {project?, limit?})` → `ChunkHit[]`** (new). Returns chunk-level passages (`content`, `heading_path`, `context`, parent `docTitle`/`docPath`, `distance`) for precise RAG context. Exposed to agents/MCP as the **`search_passages`** tool (`server/lib/agent/tools.ts`).

## Images
`server/services/image-enrich.ts`: short OCR stays summary-only (existing `images.embedding`). **Long OCR (>512 tok)** is routed through `chunkAndEmbedSource` with `source_type='image'`; on re-enrich where OCR shrinks, stale image chunks are cleared. `searchImages` (`server/services/images.ts`) fuses a third RRF lane over image-OCR chunks (reusing the single query embedding) alongside lexical + summary-vector.

## Config — `server/lib/chunking/config.ts`
`getChunkingConfig()` reads the `chunking` settings key (JSONB) over defaults: `{ contextual: true, targetTokens: 300, maxTokens: 512, overlapTokens: 32, embedBatch: 32 }`. `embedBatch` should be ≤ the rig's TEI `max_client_batch_size`; `contextual: false` disables the LLM step (breadcrumb prefix only).

## Backfill
Additive migration. `chunked_hash` starts null ⇒ the `embed-documents` cron re-chunks the whole corpus over successive rate-limited runs; un-chunked docs stay trigram-only meanwhile (no regression). Images backfill via the image-enrich cron.

## Follow-ons (not yet shipped)
- **Contextual BM25** over chunk text → Anthropic's ~49% (today only the embedding lane is contextual).
- Enable the wired-but-off **reranker** (`:8883`) on passage results → ~67%.
- **Chunk GC on hard-delete** (soft-deletes are already excluded from search via the join; orphan chunk rows are storage bloat only).
- Widen pre-collapse recall (`DISTINCT ON (source_id)` or a larger candidate budget) if many-chunk docs crowd the 100-row vector budget.
- Drop the dead `documents.embedding` / `embedded_hash` columns.
- Real Qwen tokenizer if exact chunk sizing ever matters.

Spec: [`../superpowers/specs/2026-06-17-document-chunking-contextual-retrieval-design.md`](../superpowers/specs/2026-06-17-document-chunking-contextual-retrieval-design.md) · Plan: [`../superpowers/plans/2026-06-17-document-chunking-contextual-retrieval.md`](../superpowers/plans/2026-06-17-document-chunking-contextual-retrieval.md). Related: [`search.md`](search.md), [`enrichment.md`](enrichment.md), [`mcp.md`](mcp.md).
