---
title: AI Enrichment + Notification Queue
cycle: 2
status: spec
date: 2026-06-03
supersedes: none
---

# Cycle 2 — AI Enrichment + Notification Queue

## Purpose
Make the spine smart. Fill `documents.embedding`, add semantic + RRF search on top of cycle-1's keyword search, and auto-enrich `/input` documents (propose title/project/domain/type/tags/path via the local LLM) — but never auto-apply: every AI mutation lands in a **review queue** the user approves or rejects. Also ship the cycle-1 fast-follow login page + client auth guard so the app is actually usable.

## Locked decisions (from roadmap)
Env-configured providers; embeddings = `qwen3-embedding-4b` 2560-dim via TEI; reasoning routed to the local coder model; every AI mutation reviewable/reversible.

## Deviation (documented)
TEI exposes a native `POST /embed` endpoint, NOT OpenAI `/v1/embeddings`. Rather than stand up LiteLLM, cycle 2 adds a small TEI adapter (`server/lib/ai/embeddings.ts`) that posts to `${AI_EMBEDDINGS_BASE_URL}/embed`. The reasoning role stays OpenAI-spec (`/v1/chat/completions` on the coder model). If a LiteLLM front is added later, only the adapter changes.

## Non-goals (later cycles)
OCR/image tags (cycle 3), tasks (cycle 4), memory/MCP (cycle 5), clipboard (cycle 6). No re-ranking (TEI reranker on :8883) this cycle.

## Components

### Auth UX (fast-follow)
- `app/pages/login.vue` — better-auth client email/password sign-in; on success redirect to `/documents`.
- `app/middleware/auth.global.ts` — client global route middleware: if no session, redirect to `/login`; exempt `/login` and `/share/**`. Use better-auth's Vue/Nuxt client (`authClient.useSession()` or a `/api/auth/get-session` fetch).

### Embeddings
- `server/lib/ai/embeddings.ts` — `embed(texts: string[]): Promise<number[][]>` posting to TEI `/embed`; `embedOne(text)`. Validates dim 2560.
- HNSW index migration: `CREATE INDEX documents_embedding_hnsw ON documents USING hnsw (embedding halfvec_cosine_ops);`.
- New column `documents.embedded_hash text` — the content_hash that was last embedded, so the worker re-embeds only when content changes.

### Embedding worker
- `server/tasks/embed-documents.ts` (Nitro task) — selects live docs where `embedding IS NULL OR embedded_hash IS DISTINCT FROM content_hash`, batches (e.g. 16), embeds `title || '\n\n' || content`, updates `embedding` + `embedded_hash`. Capped per run.
- Manual trigger route `POST /api/admin/embed-run` (auth-gated) returns counts.
- Scheduled via Nitro `scheduledTasks` (e.g. every few minutes). In-process, overlap-safe.

### Semantic + RRF search
- Extend `searchDocs(q)` (or add `searchDocsHybrid`): embed the query, run two lanes — trigram (existing) and vector cosine (`embedding <=> queryVec` over the HNSW index, live + non-null embedding) — fuse via RRF (k=60). Fall back to trigram-only if embeddings unavailable/empty. Keep the same `DocumentDTO[]` return so the UI is unchanged.

### Enrichment + review queue
- `review_queue` table: `id` uuid, `doc_id` uuid FK, `kind` text ('enrichment'), `proposed` jsonb (`{title?,project?,domain?,type?,tags?,path?,reasoning?}`), `status` text ('pending'|'approved'|'rejected', default pending), `created_at`, `resolved_at`. Index on status.
- `server/lib/ai/enrich.ts` — `proposeFrontmatter(doc): Promise<Proposed>` calling the reasoning model (OpenAI-spec chat) with a strict JSON-only system prompt (atomic, declarative; propose project/domain/type/tags and a target path out of `/input`). Robust JSON parse with fallback.
- `server/tasks/enrich-input.ts` (Nitro task) — selects live docs under `/input/**` with no pending/processed proposal and sparse frontmatter; calls `proposeFrontmatter`; inserts a `pending` `review_queue` row. Never mutates the doc.
- API: `GET /api/review` (pending list), `POST /api/review/[id]/approve` (applies `proposed` to the doc via the document service — set frontmatter/promoted cols, and `moveDoc` if a new path is proposed — then `resolved`), `POST /api/review/[id]/reject` (`resolved`, no change).
- UI: `app/pages/review.vue` — lists pending proposals (doc path + proposed fields + reasoning), Approve/Reject buttons; a sidebar nav item "Review" with a pending-count badge.

## Testing & validation
- Unit (vitest): RRF fusion ranking is pure-testable (extract a `rrfFuse(trigramIds, vectorIds, k)` helper); enrichment JSON parser tolerant of fenced/garbage output; embeddings adapter shape (mock fetch).
- Integration (real rig, reachable): embed a doc → `embedding` populated (dim 2560); semantic search finds a doc by meaning (query whose words don't literally appear but is semantically close); enrichment task produces a pending proposal for an `/input` doc; approve applies it and moves the doc out of `/input`.
- `playwright-cli`: login flow works (logged-out → /login → sign in → /documents); Review page shows a proposal and Approve updates the doc.
- Gates: `pnpm typecheck && pnpm build && pnpm test`.

## Definition of done
Docs auto-embed; search blends keyword + semantic; `/input` docs get LLM-proposed frontmatter into a review queue that the user approves/rejects (nothing auto-applied); a working login page guards the app. Wiki: add `enrichment.md`, update `document-spine.md` (search now hybrid) + `ai-providers.md` (embeddings adapter live); handover written; roadmap cycle-2 → shipped.
