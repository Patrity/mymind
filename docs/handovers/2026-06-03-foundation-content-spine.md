---
title: Foundation + Content Spine
cycle: 1
status: shipped
date: 2026-06-03
shipped:
  - One Nuxt 4 app on branch cycle-1-foundation-spine
  - Local Postgres (pgvector/pg16) via docker-compose with pgcrypto/pg_trgm/ltree/vector; port 5433
  - Drizzle client + custom halfvec(2560) column type + runtimeConfig env wiring
  - documents table (hybrid path + frontmatter; promoted columns project/domain/type/tags/topic-ltree; embedding halfvec(2560) placeholder; trigram + gist indexes) and minimal projects table
  - better-auth email/password session auth + api_tokens + dual session/bearer middleware (segment-precise, immediate bearer reject, www-authenticate)
  - document service seam + REST routes (tree/CRUD/move/share/search) + public /api/share/[slug]
  - useDocuments composable
  - storage abstraction (local default, S3 dormant) ported from copipasta
  - CodeMirror editor + MDC view; split document browser/editor page (edit/preview/split, autosave, metadata form, search, share); public /share/[slug] page; default/public layout split
  - env-configured OpenAI-spec AI provider factory (scaffold, unused)
  - "SECURITY (final review): public sign-up disabled by default (ALLOW_SIGNUP gate); trustedOrigins derived from BETTER_AUTH_URL"
deferred:
  - "FAST-FOLLOW (review #2): no login page / client auth guard — APIs enforce auth but pages render for anon and there's no sign-in UI"
  - "FAST-FOLLOW (review #4): duplicate/invalid path on create/move returns raw 500; map unique-violation (23505) to 409"
  - "CYCLE-2 (review #5): autosave is last-writer-wins; add optimistic concurrency via contentHash/updatedAt precondition"
  - "CYCLE-2 (review #6): harden halfvec.fromDriver for empty/malformed vectors before the column is read"
  - "CYCLE-2 (review #7): search is a seq-scan (leading-% ilike); trigram GIN won't accelerate it — revisit with semantic search"
  - "CYCLE-2 (review #8): verify MDC sanitizes untrusted markdown on the public page once AI-generated content flows"
  - All AI behaviour (embedding worker, semantic/RRF search, /input auto-tag/sort/frontmatter, OCR, enrichment) -> cycle 2
  - HNSW index on documents.embedding -> cycle 2 (added once column is populated)
  - Deep-linking ?doc=<id> auto-load (selectedId is local state, not URL-synced) -> polish
  - Tree drag-drop/move UI (move API exists; UI uses simple browse+select+delete) -> polish
  - useDocuments uses raw ofetch instead of $fetch (dodges $fetch DELETE type-narrowing); fine for client-driven calls -> minor tech-debt
  - API-token management UI (tokens insertable via DB; settings CRUD page) -> later
next_seam: "Cycle 2 (AI Enrichment): implement an embedding worker that fills documents.embedding via aiProvider('embeddings'), add the HNSW cosine index, and extend searchDocs() with semantic + RRF fusion on the existing search surface. The provider factory (server/lib/ai/provider.ts) and the halfvec column are already in place."
validation: "typecheck + build + 9 vitest tests pass; full playwright-cli browser E2E green (create/edit/preview/persist/search/share + public page without sidebar); API-token boundary 200/401/401."
---

# Cycle 1 — Foundation + Content Spine (handover)

Shipped a manual-but-complete, Postgres-backed Markdown document manager with dual auth and the pgvector/storage/AI-provider seams ready for cycle 2. Built via subagent-driven development (per-task implement → review), 17 tasks across 4 phases.

## How to run

```bash
docker compose up -d db
cp .env.example .env   # then set BETTER_AUTH_SECRET; DATABASE_URL already targets port 5433
pnpm install
pnpm db:migrate
pnpm dev               # http://localhost:3000 -> /documents
```
Test account used in validation: `tony@test.local` / `test-password-123` (created via better-auth sign-up).

## Key decisions / deviations discovered during build
- **Port 5433**, not 5432 (5432 was occupied by another project's container). Reflected in docker-compose.yml + .env.example.
- **Zod v4** installed — route schemas use `z.record(z.string(), z.unknown())` (two-arg form).
- **better-auth schema hand-written** (CLI `generate` crashes on Nuxt auto-imports); `useAuth` singleton typed `any` to dodge better-auth generic variance (runtime-safe).
- **h3 v1.15** `createError` rejects a `headers` field → 401s set `www-authenticate` via `setResponseHeader`.
- **drizzle queries are lazy** — fire-and-forget `lastUsedAt` uses `.execute().catch()`.
- **`UButtonGroup` does not resolve in this Nuxt UI v4** — replaced with a styled div group.
- **App shell moved to `layouts/default.vue`**; public `/share/[slug]` opts out with `layout: false`.

## Where things live
- DB seam: `server/services/documents.ts` (nothing else touches the documents table). Tree builder: `server/services/tree.ts`.
- Schema: `server/db/schema/{documents,projects,auth,api-tokens}.ts`; halfvec type: `server/db/types/halfvec.ts`.
- Auth: `server/utils/auth.ts`, `server/middleware/auth.ts`, `server/utils/api-token.ts`.
- API: `server/api/documents/*`, `server/api/share/[slug].get.ts`.
- UI: `app/pages/documents.vue`, `app/components/documents/{Tree,Editor}.vue`, `app/components/{CodeEditor.client,MdView}.vue`, `app/layouts/default.vue`, `app/pages/share/[slug].vue`.
- AI seam: `server/lib/ai/provider.ts`. Storage: `server/utils/storage/*`.
