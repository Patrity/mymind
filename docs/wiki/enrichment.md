---
title: AI Enrichment + Review Queue
status: shipped
cycle: 2
updated: 2026-06-17
---

# AI Enrichment + Review Queue

Auto-embeds documents and proposes frontmatter for `/input` docs via the local LLM. **Nothing is auto-applied** — proposals land in a review queue the user approves/rejects.

## Embeddings
- Adapter `server/lib/ai/embeddings.ts`: `embed(texts)` / `embedOne(text)` POST to TEI `${AI_EMBEDDINGS_BASE_URL}/embed`, validate 2560 dims. (TEI is native `/embed`, not OpenAI `/v1/embeddings` — documented deviation.)
- Worker `server/services/embedding.ts` `runEmbedding({limit,batch})`: embeds live docs where `embedding IS NULL OR embedded_hash IS DISTINCT FROM content_hash`; writes `embedding` + `embedded_hash`. Nitro task `embed-documents` (*/5); manual `POST /api/admin/embed-run`.
- Storage: `documents.embedding halfvec(2560)` + HNSW cosine index `documents_embedding_hnsw`.

## Hybrid search
`searchDocs(q)` (`server/services/documents.ts`) runs two lanes — trigram (ilike + similarity) and vector cosine (`embedding <=> query::halfvec` over HNSW) — fused with `rrfFuse` (`server/lib/ai/rrf.ts`, k=60). Falls back to trigram-only if embeddings are unavailable. Returns `DocumentDTO[]` (UI unchanged).

## Enrichment + review queue
- Chat helper `server/lib/ai/chat.ts`: `chat(role, messages, opts)` → OpenAI-spec `/v1/chat/completions` on the configured role (reasoning = local coder model).
- Proposer `server/lib/ai/enrich.ts`: `buildEnrichMessages(doc, projects)` / `proposeFrontmatter(doc, projects?)` asks the reasoning model for STRICT JSON (`title/project/domain/type/tags/path/reasoning`). **Project classification:** when active projects exist, the system prompt includes the full project list (slug — name — description) and instructs the model to pick the single best-matching slug (or null). If a project is chosen, `path` is set to `/projects/<slug>/<filename>`; if null, path must not be under `/projects/`. `parseProposal(raw)` tolerates code fences / surrounding prose / coerces tags, returns null on failure.
- Task `server/services/enrichment.ts` `runEnrichInput()` + `enrich-input` (*/10) + `POST /api/admin/enrich-run`: scans `/input/**` docs with sparse metadata and no existing queue row; inserts a `pending` `review_queue` row. Never mutates the doc.
- `review_queue` table: `id, doc_id, kind, proposed jsonb, status (pending|approved|rejected), created_at, resolved_at`.
- API `server/api/review/*`: `GET /api/review` (pending + doc path), `GET /api/review/count`, `POST /api/review/[id]/approve` (applies proposal via `updateDoc` + optional `moveDoc` out of `/input`, then `approved`), `POST /api/review/[id]/reject`.
- UI `app/pages/review.vue` + sidebar "Review" nav item with a reactive pending-count badge.

## Auth UX (cycle-1 fast-follow)
`app/pages/login.vue` (UAuthForm) + `app/middleware/auth.global.ts` (client-only guard; redirects anon to `/login`, exempts `/login` and `/share/**`) + `app/lib/auth-client.ts` (better-auth Vue client).
