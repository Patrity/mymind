# AI Enrichment + Notification Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Auto-embed documents, blend keyword + semantic (RRF) search, LLM-propose `/input` frontmatter into a human review queue (never auto-applied), and add a login page + client auth guard.

**Architecture:** TEI embeddings via a small adapter; an in-process Nitro task fills `documents.embedding`; search fuses trigram + vector cosine via RRF; an enrichment task writes proposals to a `review_queue` resolved through approve/reject endpoints + a Review UI.

**Tech Stack:** Nuxt 4, Drizzle/Postgres+pgvector (HNSW), TEI (`/embed`), local coder LLM (`/v1/chat/completions`), Vitest, playwright-cli.

**Validation env:** AI rig 192.168.2.25 is reachable (TEI :8882 returns 2560-dim; coder :8004 with key). `.env` is wired.

---

### Task 1: Login page + client auth guard (cycle-1 fast-follow)
**Files:** Create `app/pages/login.vue`, `app/middleware/auth.global.ts`, possibly `app/composables/useAuthClient.ts` (better-auth Vue client).
- [ ] Add better-auth client (`better-auth/vue` `createAuthClient`) exposing `signIn.email`, `useSession`/`getSession`.
- [ ] `login.vue`: email+password form → `authClient.signIn.email`; on success `navigateTo('/documents')`. Uses `layout: false` (no dashboard chrome).
- [ ] `auth.global.ts` (client): resolve session; if none and route is not `/login` or `/share/**`, `return navigateTo('/login')`. Avoid redirect loops.
- [ ] Verify: logged-out visit to `/documents` redirects to `/login`; sign in with `tony@test.local`/`test-password-123` lands on `/documents`; `/share/<slug>` still public. typecheck+build. Commit.

### Task 2: Embeddings adapter (TEI) + RRF helper (TDD)
**Files:** Create `server/lib/ai/embeddings.ts`, `server/lib/ai/rrf.ts`, `test/embeddings.test.ts`, `test/rrf.test.ts`.
- [ ] TDD `rrf.ts`: `rrfFuse(lanes: string[][], k=60): string[]` — reciprocal-rank fusion of ranked id lists, dedup, sorted by summed 1/(k+rank). Tests pin ordering.
- [ ] `embeddings.ts`: `embed(texts: string[]): Promise<number[][]>` POSTs `{inputs: texts}` to `${useRuntimeConfig().ai.embeddings.baseURL}/embed`; normalizes TEI's response (array-of-vectors) to `number[][]`; throws if any vector length ≠ 2560. `embedOne(t)` convenience. Test with mocked `$fetch`/fetch (shape only — no network in unit tests).
- [ ] typecheck + test. Commit.

### Task 3: HNSW index + `embedded_hash` column (migration)
**Files:** Modify `server/db/schema/documents.ts`; new migration.
- [ ] Add `embeddedHash: text('embedded_hash')` column.
- [ ] `pnpm db:generate`; append to the migration: `CREATE INDEX IF NOT EXISTS documents_embedding_hnsw ON documents USING hnsw (embedding halfvec_cosine_ops);`
- [ ] `pnpm db:migrate`; verify column + HNSW index via psql. Commit.

### Task 4: Embedding worker + manual trigger (validate vs real rig)
**Files:** Create `server/tasks/embed-documents.ts`, `server/api/admin/embed-run.post.ts`; add scheduledTasks to `nuxt.config.ts`.
- [ ] Worker `run({limit})`: select live docs where `embedding IS NULL OR embedded_hash IS DISTINCT FROM content_hash`, batch 16, `embed(title||'\n\n'||content)`, update `embedding` + `embedded_hash`. Return `{embedded, remaining}`.
- [ ] `POST /api/admin/embed-run` (auth-gated) → `run({limit:200})`.
- [ ] Register `scheduledTasks` (e.g. `'*/5 * * * *'`) in nuxt.config; export the task in `server/tasks/`.
- [ ] Validate vs rig: dev up, sign in, create a doc, hit `/api/admin/embed-run`, confirm via psql that `embedding IS NOT NULL` for that row and `vector_dims(embedding::vector)=2560`. Commit.

### Task 5: Hybrid (keyword + semantic) search
**Files:** Modify `server/services/documents.ts` (+ use `rrf.ts`, `embeddings.ts`); `server/api/documents/search.get.ts` unchanged interface.
- [ ] `searchDocs(q)`: run trigram lane (existing top-N ids) + vector lane (`embedding <=> embedOne(q)` cosine, top-N, only rows with non-null embedding, live); `rrfFuse([trigramIds, vectorIds])`; hydrate DTOs in fused order; cap 50. If embedding fails or no embedded rows, fall back to trigram-only (catch + log).
- [ ] Validate vs rig: a query that is semantically related but shares no literal words returns the doc (after Task 4 embedded it). typecheck+build. Commit.

### Task 6: review_queue schema + enrichment (proposer + task)
**Files:** Create `server/db/schema/review-queue.ts`, `server/lib/ai/enrich.ts`, `server/tasks/enrich-input.ts`, `test/enrich-parse.test.ts`; migration.
- [ ] `review_queue` table (id, doc_id FK, kind, proposed jsonb, status default 'pending', created_at, resolved_at; index status). Migrate.
- [ ] `enrich.ts`: `proposeFrontmatter(doc)` → OpenAI-spec chat to `ai.reasoning` with a strict JSON-only system prompt (propose title/project/domain/type/tags + a target path out of `/input`, plus short reasoning). Tolerant JSON extraction (strip code fences, find first `{...}`); on parse failure return null. TDD the parser with a separate exported `parseProposal(raw)`.
- [ ] `enrich-input.ts` task: select live `/input/**` docs with no pending/resolved enrichment row and sparse metadata (no project/tags); call proposer; insert `pending` row. Never mutate the doc. Cap per run.
- [ ] typecheck + test. Commit.

### Task 7: review API + Review UI
**Files:** Create `server/api/review/index.get.ts`, `server/api/review/[id]/approve.post.ts`, `server/api/review/[id]/reject.post.ts`, `app/pages/review.vue`; add nav item + badge.
- [ ] `GET /api/review` → pending rows joined with doc path. `approve` → apply `proposed` via document service (`updateDoc` for frontmatter/promoted cols; `moveDoc` if `proposed.path` set and differs), set `status='approved', resolved_at`. `reject` → `status='rejected', resolved_at`.
- [ ] `review.vue`: list pending (doc path, proposed fields, reasoning), Approve/Reject buttons calling the endpoints, refresh after. Sidebar "Review" nav item (`i-lucide-inbox`) with pending-count badge (fetch count).
- [ ] typecheck + build. Commit.

### Task 8: E2E validation + handover + merge prep
**Files:** Create `docs/handovers/2026-06-03-ai-enrichment.md`; update wiki + roadmap.
- [ ] Gates: `pnpm typecheck && pnpm build && pnpm test`.
- [ ] playwright-cli: logged-out → `/login` → sign in → `/documents`; create an `/input` doc; run enrich task (trigger via a temporary route or `nitro` task runner) → Review page shows a proposal → Approve → doc gains frontmatter and moves out of `/input`. Capture a screenshot.
- [ ] Rig integration recap: embedding populated; semantic search hit; enrichment proposal generated by the real model.
- [ ] Write handover (accurate frontmatter, deferrals, next_seam = cycle 3). Add wiki `enrichment.md`; bump `document-spine.md`/`ai-providers.md`. Roadmap cycle-2 → shipped. Commit.

---

## Self-Review
Spec coverage: login+guard (T1) ✓ · embeddings adapter + HNSW + worker (T2–T4) ✓ · hybrid RRF search (T5) ✓ · enrichment proposer + task + review queue + API + UI (T6–T7) ✓ · validation/docs (T8) ✓. Pure-testable units extracted (rrfFuse, parseProposal). AI-action review surface = nothing auto-applied; approve is the only mutation path. Fallback to trigram-only keeps search robust if the rig is down.
