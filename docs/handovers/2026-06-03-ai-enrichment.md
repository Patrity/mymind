---
title: AI Enrichment + Notification Queue
cycle: 2
status: shipped
date: 2026-06-03
shipped:
  - Login page (UAuthForm) + global client auth guard (cycle-1 fast-follow); logged-out users redirected to /login, /share/** still public
  - TEI embeddings adapter (server/lib/ai/embeddings.ts, POST /embed, 2560-dim) + reusable OpenAI-spec chat helper (server/lib/ai/chat.ts)
  - RRF fusion helper (server/lib/ai/rrf.ts, TDD)
  - documents.embedded_hash column + HNSW cosine index (documents_embedding_hnsw)
  - Embedding worker (server/services/embedding.ts) as a Nitro scheduled task (*/5) + manual POST /api/admin/embed-run — VALIDATED vs real rig (dim 2560)
  - Hybrid search: searchDocs fuses trigram + vector cosine via RRF, trigram fallback — VALIDATED (semantic hit on zero-overlap query)
  - review_queue table + enrichment proposer (server/lib/ai/enrich.ts, reasoning LLM, TDD parser) + enrich-input Nitro task (*/10) + POST /api/admin/enrich-run — VALIDATED vs real rig (clean JSON proposals)
  - Review API (GET /api/review, /count, [id]/approve applies proposal via document service + moveDoc, [id]/reject) + Review UI page + sidebar nav with reactive pending badge
deferred:
  - "Notification system beyond the review queue (e.g. OCR-failed, ambiguous-project alerts) -> arrives with the image/capture cycle that generates those events"
  - "TEI reranker (:8883) to re-score fused results -> later quality pass"
  - "Embeddings still bypass the OpenAI-spec provider (TEI native /embed); revisit if a LiteLLM front is added"
  - "Login page hydration mismatch warning + a pre-auth icon 401 (cosmetic, not regressions) -> polish"
  - "ef_search / HNSW tuning not needed yet (small corpus); revisit at scale"
  - "review_queue approve: path collision silently leaves doc in place (try/catch) — acceptable; could surface a conflict notice"
next_seam: "Cycle 3 (Quick Capture + Image Hosting): use the existing storage abstraction (server/utils/storage) for uploads (ShareX/CleanShot endpoints), sharp->webp, and aiProvider('vision')/chat for OCR tags; failures/ambiguities feed the same review_queue pattern. Quick-capture notes drop into /input and ride the cycle-2 enrichment pipeline automatically."
validation: "typecheck + build + 26 vitest tests; playwright-cli E2E (login guard -> sign in -> review approve + badge -> hybrid search UI); real-rig: 6 docs embedded (dim 2560), semantic search hit, LLM enrichment proposals generated + approved."
---

# Cycle 2 — AI Enrichment + Notification Queue (handover)

Made the spine smart and added the login UX. Documents now auto-embed against the local TEI rig, search blends keyword + semantic (RRF), and `/input` docs get LLM-proposed frontmatter into a human-gated review queue — nothing is auto-applied; **Approve** is the only mutation path.

## How to run (additions over cycle 1)
- `.env` AI vars must point at the rig: `AI_EMBEDDINGS_BASE_URL=http://192.168.2.25:8882` (TEI, no key), `AI_REASONING_BASE_URL=http://192.168.2.25:8004/v1` + `AI_REASONING_API_KEY` + `AI_REASONING_MODEL=qwen3.6-27b-coder`.
- Background tasks run on a schedule (embed */5, enrich-input */10); trigger manually with `POST /api/admin/embed-run` and `POST /api/admin/enrich-run` (auth required).
- First run: sign in at `/login`, drop notes under `/input`, they get embedded + proposed; approve in `/review`.

## Key decisions / deviations
- **TEI is not OpenAI-spec** — embeddings use a dedicated `/embed` adapter (documented deviation). Reasoning/chat use the standard `/v1/chat/completions`.
- **Auth guard is client-only** (`import.meta.server` short-circuit) — simplest for single-user; APIs still enforce auth independently.
- **Nothing auto-applies** — enrichment writes `pending` review_queue rows; approve applies via the document service (frontmatter/promoted cols + optional move out of `/input`).
- Coder model returned clean JSON first-try; the tolerant `parseProposal` (fences/prose/garbage→null) is still the safety net.

## Where things live
- AI libs: `server/lib/ai/{embeddings,chat,enrich,rrf,provider}.ts`. Workers: `server/services/{embedding,enrichment}.ts` + `server/tasks/{embed-documents,enrich-input}.ts`. Admin triggers: `server/api/admin/*`.
- Search: `server/services/documents.ts` `searchDocs` (now hybrid). Review: `server/api/review/*`, `app/pages/review.vue`. Auth UX: `app/pages/login.vue`, `app/middleware/auth.global.ts`, `app/lib/auth-client.ts`.
