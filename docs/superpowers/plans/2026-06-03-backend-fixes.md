# Backend Fixes & AI Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Fix the OCR retry loop, cap tag counts, make transcriptions markdown-first with inferred titles, auto-review high-confidence memories (+ strip unreviewed tag), and expose memory-search relevance scores.

**Tech Stack:** Nuxt 4, Drizzle/Postgres, vision (qwen3-vl-8b :8005), reasoning (qwen3.6-27b-coder :8004), reranker (:8883 optional), Vitest.

**Rig:** reachable. Don't run the OCR/enrich scheduled tasks against a down endpoint — validate with manual triggers.

---

### Task 1: OCR retry-loop fix + tag cap
**Files:** `server/db/schema/images.ts` (+migration); `server/services/image-ocr.ts`; `server/lib/ai/vision.ts`; `server/lib/ai/enrich.ts` (tag clamp); `test/tag-cap.test.ts`.
- [ ] Add `ocrAttempts: integer('ocr_attempts').notNull().default(0)` to images; migrate.
- [ ] `runImageOcr`: candidate `where` = `ocrText IS NULL AND ocr_attempts < 3` (+ existing live + kind in (image,gif)). On success set `ocrText` (`result.ocrText` or `''` sentinel if empty) + capped `recommendedTags`. On failure/empty-throw: `set({ ocrAttempts: sql\`ocr_attempts + 1\` })` and continue. Remove the always-null path.
- [ ] `vision.ts` describeImage prompt: "suggest 5–7 concise tags (max 10)". Post-cap `tags.slice(0,10)`.
- [ ] `enrich.ts` (doc frontmatter proposer): clamp proposed `tags` to ≤10. Pure `capTags(tags, n=10)` helper — TDD (`test/tag-cap.test.ts`: dedups + caps).
- [ ] Validate (rig, manual trigger): upload a text image, `POST /api/admin/ocr-run`, confirm ≤10 tags; simulate a failure (point vision at a bad port via a temp env OR just confirm the attempts column increments by inspecting an image that fails) — confirm `ocr_attempts` increments and a 3-attempt image is no longer selected. typecheck+test. Commit.

### Task 2: markdown-first transcription + title inference
**Files:** `server/lib/ai/vision.ts` (md prompt), `server/lib/ai/transcribe.ts` (new: clean+title via reasoning), `server/api/capture/transcribe.post.ts`.
- [ ] `vision.ts`: prompt the model to return markdown faithful to layout (headings/lists/checkboxes/bold), not flattened text. Keep the `{ocrText, tags}` shape (ocrText now markdown).
- [ ] `server/lib/ai/transcribe.ts` `cleanToMarkdown(raw): Promise<{ title: string, markdown: string }>` — `chat('reasoning', [...])` with a strict prompt: "Reformat this OCR text into clean, faithful Markdown (headings, `-` lists, `- [ ]` checkboxes, bold where appropriate). Infer a concise title. Output JSON {title, markdown}." Tolerant parse; fallback `{ title: 'Transcribed note', markdown: raw }`.
- [ ] `transcribe.post.ts`: vision OCR → `cleanToMarkdown(ocrText)` → `createDoc({ path:'/input/<slug-of-title>.md', title, content: markdown })`.
- [ ] Validate (rig): transcribe a list-style note image → doc has markdown lists/headings + a sensible title (not the filename). typecheck+build. Commit.

### Task 3: memory auto-review + reviewed-tag strip + relevance scores
**Files:** `server/services/memory.ts`; `nuxt.config.ts` (autoReviewThreshold, optional rerank base); `server/lib/ai/rerank.ts` (optional); `app/pages/memories.vue` (+ `useMemories`) for relevance display; `test/auto-review.test.ts`.
- [ ] Config `memoryAutoReviewThreshold` (default 0.75). In `createMemory`: if `confidence >= threshold` → set `reviewedAt = now()` and DON'T add `unreviewed` tag (filter it out). Pure `shouldAutoReview(confidence, threshold)` + tag-strip helper — TDD.
- [ ] `reviewMemory(id)`: also strip `unreviewed` from `tags`.
- [ ] `searchMemories`: return each result with a `relevance` number — normalize the fused RRF rank to 0–1 (e.g. `1/(1+rank)` or min-max over the result set). Optional: if `AI_RERANK_BASE_URL` set, call `server/lib/ai/rerank.ts` `rerank(query, docs)` (Qwen3-Reranker `:8883`) to reorder + score; fallback to RRF score. Add `relevance?: number` to the search DTO.
- [ ] `memories.vue`: when results came from a search, show the `relevance` % badge instead of `confidence`; list view keeps confidence. (Small tweak.)
- [ ] Validate: a 0.9-confidence memory created → reviewed, no unreviewed tag; reviewing a low-confidence one strips the tag + drops the badge count; `GET /api/memories?q=...` returns `relevance`. typecheck+test+build. Commit.

### Task 4: E2E + handover + merge
- [ ] Gates typecheck/build/test.
- [ ] Integration recap (rig): OCR tag count ≤10 + attempts cap; transcription markdown+title; memory auto-review + relevance.
- [ ] playwright-cli quick check: Memories page shows relevance on search, unreviewed badge correct after review.
- [ ] Handover; update wiki (enrichment/memory/image-hosting/quick-capture); roadmap cycle-7 → shipped. Final review; fix blockers; merge.

---

## Self-Review
Coverage: OCR loop (T1) ✓ · tag cap (T1) ✓ · md transcription + title (T2) ✓ · auto-review + reviewed-tag + relevance (T3) ✓ · validation/docs/merge (T4) ✓. Pure units: capTags, shouldAutoReview, tag-strip. Reranker optional/flagged. Validate via manual triggers (don't hammer a down endpoint).
