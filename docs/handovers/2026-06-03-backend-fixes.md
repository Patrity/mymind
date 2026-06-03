---
title: Backend Fixes & AI Quality
cycle: 7
status: shipped
date: 2026-06-03
feedback: ../../scope-feedback.md
shipped:
  - "OCR retry loop fixed: images.ocr_attempts column; candidate + remaining queries require ocr_attempts<3 + kind in (image,gif); success sets ocr_text (''=attempted sentinel), failure/empty increments attempts. No more infinite re-scan / error spam when vision (:8005) blips."
  - "Tag cap: capTags(tags,10) helper (TDD); vision prompt asks 5-7 (max 10); image OCR recommended_tags + doc-enrichment proposed tags both capped 10. Stale >10-tag rows trimmed."
  - "Markdown-first transcription: vision OCR prompt returns structure-preserving markdown; transcribe route runs raw OCR through the reasoning model (cleanToMarkdown) for faithful markdown (headings/lists/checkboxes/bold) + an inferred title. Proven on the real failing example."
  - "Memory auto-review: shouldAutoReview(confidence>=0.75 default, config MEMORY_AUTO_REVIEW_THRESHOLD) auto-sets reviewed_at + strips 'unreviewed' tag on creation; reviewMemory also strips 'unreviewed'. Only low-confidence memories need human review now."
  - "Memory search relevance: searchMemories attaches relevance (1/(1+rank)); Memories UI shows a relevance badge on search results (confidence in list mode). Optional Qwen3-Reranker (:8883) behind AI_RERANK_BASE_URL (OFF by default)."
deferred:
  - "Vision model (:8005, 8B) is weak + flaky; transcription quality now leans on the 27B reasoning cleanup. Consider a larger vision model or retry/backoff on :8005 if outages persist."
  - "Reranker is wired but OFF by default (AI_RERANK_BASE_URL empty) — enable to use :8883 for relevance."
  - "BETTER_AUTH_URL must match the actual served origin/port or the login form 403s (origin check). Dev sometimes falls back to :3001 when :3000 is busy — set BETTER_AUTH_URL accordingly. (Cycle 8 SPA conversion + login fix will revisit.)"
next_seam: "Cycle 8 (Global UX & architecture): SPA conversion (ssr:false for the authed app, SSR/prerender only for /share/** + /i/**) — fixes the pre-login flash AND the recurring hydration warnings; then the command palette (UDashboardSearch) with semantic search across docs/memories/gallery-tags/tasks (reuse searchDocs + searchMemories + new search surfaces)."
validation: "typecheck + build + 107 vitest tests; rig/DB: OCR attempts cap excludes >=3 rows, tags <=10, memory auto-review + relevance badges + review strips unreviewed tag (badge 7->6); transcription markdown+title proven via reasoning model on the real example (vision :8005 was down during final validation)."
---

# Cycle 7 — Backend Fixes & AI Quality (handover)

Round-2 feedback batch 1: fixed the backend bugs and raised AI output quality on the shipped base. No new surfaces.

## What changed & why (from scope-feedback.md)
- **OCR rescan loop** → bounded by `ocr_attempts < 3`; failures/empties increment instead of leaving `ocr_text` NULL forever. This also stops the error spam you saw when `:8005` was unreachable.
- **20-tag dumps** → `capTags(…,10)` everywhere; prompt asks for 5–7.
- **Poor handwriting transcription** → markdown-first vision prompt + a reasoning-model (`27B`) cleanup pass that reformats to faithful markdown and infers a title. The small 8B vision model no longer determines final quality.
- **Over-asking for memory review** → high-confidence (≥0.75) memories auto-review; the `unreviewed` tag is stripped on review (manual or auto), so the badge reflects only genuinely-unreviewed items.
- **Confidence shown for search** → search results now show a **relevance** score (rank-based; optional reranker), simulating MCP ranking; list mode still shows confidence.

## Where things live
`server/services/image-ocr.ts` (attempts cap), `shared/utils/cap-tags.ts`, `server/lib/ai/vision.ts` (md prompt + tag cap), `server/lib/ai/transcribe.ts` (cleanToMarkdown), `server/api/capture/transcribe.post.ts`, `server/services/memory.ts` (auto-review, stripUnreviewed, relevance), `server/lib/ai/rerank.ts` (optional), `app/pages/memories.vue`.
