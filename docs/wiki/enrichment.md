---
title: AI Enrichment + Review Queue
status: shipped
cycle: 2
updated: 2026-08-16
mymind_id: 32b3e56a-40ca-4286-a222-39b1bb6ec9a5
mymind_hash: 8acdf937e7c7c36c9cf28e01334a9208a5acbab7c70b09508234f8d619585dec
---

# AI Enrichment + Review Queue

Auto-embeds documents and proposes frontmatter for `/input` docs via the local LLM. **Nothing is auto-applied** — proposals land in a review queue the user approves/rejects.

> **SUPERSEDED 2026-08-16 (cycle 57) — `enrich-input` is retired; capture triage owns `/input`
> now.** The `enrich-input` scheduled task is **deleted** (`server/tasks/enrich-input.ts`, removed
> in `223f38e`; `nuxt.config.ts`'s `scheduledTasks` runs `triage-input` in its place — see
> `nuxt.config.ts:108-113`). The candidate population it used to scan (`/input/**` with sparse
> metadata and no existing review row) is exactly what `triageCapture`/`sweepUntriaged` now own,
> and the Note actuator subsumes what its frontmatter proposal did — see
> [triage.md](triage.md). The `runEnrichInput()` function and its manual trigger
> (`POST /api/admin/enrich-run`) still exist in `server/services/enrichment.ts` — nothing
> deleted the code, only the schedule that called it automatically — but nothing invokes either
> in normal operation anymore. The **enrichment + review queue** section below is kept
> **verbatim, for history** — it accurately describes the `enrich-input` era (cycles 2–56) but
> no longer describes what runs today. The `enrichment` `kind` on `review_queue` stays readable
> for historical rows. (The **embeddings**/**hybrid search** sections immediately below have
> their own, separate, older correction — see the note at their start — unrelated to triage but
> caught while fixing this page.)

> **Separate correction (2026-08-16) — the Embeddings section below predates cycle 31 and is
> stale about storage.** It describes whole-document embedding straight onto
> `documents.embedding`. That was replaced in **cycle 31** ("Document Chunking + Contextual
> Retrieval") — `documents.embedding` is vestigial and has never been written by any code in
> this repo (see the correction in [document-spine.md](document-spine.md)). The real pipeline:
> `runEmbedding()` (`server/services/embedding.ts`, still the `embed-documents` task, still
> `*/5`) now compares `documents.chunked_hash` against `documents.content_hash` and, when stale,
> calls `chunkAndEmbedSource()` to delete-and-reinsert that document's rows in the generic
> `chunks` table (`source_type = 'document'`) — chunked, contextualized, and embedded there, not
> as one whole-document vector. Search's vector lane joins `chunks` accordingly (see Hybrid
> search below and `searchDocIds` in `server/services/documents.ts`). The paragraphs below are
> left as-is for history; treat `chunks` + `chunked_hash` as current, `embedding`/`embedded_hash`
> as dead.

## Embeddings
- Adapter `server/lib/ai/embeddings.ts`: `embed(texts)` / `embedOne(text)` POST to TEI `${AI_EMBEDDINGS_BASE_URL}/embed`, validate 2560 dims. (TEI is native `/embed`, not OpenAI `/v1/embeddings` — documented deviation.)
- Worker `server/services/embedding.ts` `runEmbedding({limit,batch})`: embeds live docs where `embedding IS NULL OR embedded_hash IS DISTINCT FROM content_hash`; writes `embedding` + `embedded_hash`. Nitro task `embed-documents` (*/5); manual `POST /api/admin/embed-run`.
- Storage: `documents.embedding halfvec(2560)` + HNSW cosine index `documents_embedding_hnsw`.

## Hybrid search
`searchDocs(q)` (`server/services/documents.ts`) runs two lanes — trigram (ilike + similarity) and vector cosine (`chunks.embedding <=> query::halfvec` over HNSW, joined back to `documents` by `sourceId` — see the correction above) — fused with `rrfFuse` (`server/lib/ai/rrf.ts`, k=60). Falls back to trigram-only if embeddings are unavailable. Returns `DocumentDTO[]` (UI unchanged).

## Enrichment + review queue
- Chat helper `server/lib/ai/chat.ts`: `chat(role, messages, opts)` → OpenAI-spec `/v1/chat/completions` on the configured role (reasoning = local coder model).
- Proposer `server/lib/ai/enrich.ts`: `buildEnrichMessages(doc, projects)` / `proposeFrontmatter(doc, projects?)` asks the reasoning model for STRICT JSON (`title/project/domain/type/tags/path/reasoning`). **Project classification:** when active projects exist, the system prompt includes the full project list (slug — name — description) and instructs the model to pick the single best-matching slug (or null). If a project is chosen, `path` is set to `/projects/<slug>/<filename>`; if null, path must not be under `/projects/`. `parseProposal(raw)` tolerates code fences / surrounding prose / coerces tags, returns null on failure.
- Task `server/services/enrichment.ts` `runEnrichInput()` + `enrich-input` (*/10, **retired 2026-08-16 — see the superseded note above**) + `POST /api/admin/enrich-run` (function still present, no longer scheduled): scans `/input/**` docs with sparse metadata and no existing queue row; inserts a `pending` `review_queue` row. Never mutates the doc.
- `review_queue` table: `id, doc_id, kind, proposed jsonb, status (pending|approved|rejected), created_at, resolved_at`.
- API `server/api/review/*`: `GET /api/review` (pending + doc path), `GET /api/review/count`, `POST /api/review/[id]/approve` (applies proposal via `updateDoc` + optional `moveDoc` out of `/input`, then `approved`), `POST /api/review/[id]/reject`.
- UI `app/pages/review.vue` + sidebar "Review" nav item with a reactive pending-count badge.
- **capture-triage task 13 — `/review` is the single approval surface.** `server/services/review.ts` (`listReviewFeed`/`countReviewPending`, called by the two GET endpoints above) merges real `review_queue` rows with **synthetic `memory-unreviewed` items** sourced from `memories` where `reviewed_at IS NULL` (live only). A synthetic item's `id` is a `memories.id`, never a `review_queue.id` — `docId`/`docPath` are `null`, and approving it calls `reviewMemory(id)` (`useMemories()`'s `review` action) directly, not `POST /api/review/[id]/approve` (which 404s on an id `review_queue` doesn't have). `GET /api/review/count`'s `pending` sums both sources — it's the sidebar's only badge now; `/memories` lost its separate "Mark reviewed" button and unreviewed-count badge (kept the "Unreviewed only" filter as a view). See [memory.md](memory.md)'s UI section.

## Auth UX (cycle-1 fast-follow)
`app/pages/login.vue` (UAuthForm) + `app/middleware/auth.global.ts` (client-only guard; redirects anon to `/login`, exempts `/login` and `/share/**`) + `app/lib/auth-client.ts` (better-auth Vue client).
