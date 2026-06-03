---
title: Backend Fixes & AI Quality
cycle: 7
status: spec
date: 2026-06-03
supersedes: none
feedback: ../../scope-feedback.md
---

# Cycle 7 — Backend Fixes & AI Quality

## Purpose
Fix the backend issues from first-pass feedback and raise AI output quality. No new surfaces; targeted fixes to existing services.

## Items (from scope-feedback.md)

### 1. OCR rescan loop (BUG)
`image-ocr.runImageOcr` re-selects `ocr_text IS NULL` every 7 min, but failures (ECONNREFUSED) and empty results leave `ocr_text` NULL → the same images are retried forever, spamming errors when the vision model blips.
- Add `ocr_attempts integer not null default 0` to `images`.
- Candidate query: `ocr_text IS NULL AND ocr_attempts < 3` (live, kind image/gif).
- On success: set `ocr_text` (use `''` sentinel when the model returns no text — still "attempted"), `recommended_tags`. On failure/empty: `ocr_attempts = ocr_attempts + 1` (so it retries a couple times for transient outages, then stops). Manual re-run endpoint may reset attempts.

### 2. Tag count cap (BUG)
OCR recommended ~20 tags. Vision prompt must request **5–7 tags (max 10)**, and `runImageOcr` caps `recommended` to 10 after splitTags. Same cap applied to the doc-enrichment tag proposals (cycle-2 `enrich`) — clamp tags to ≤10.

### 3. Transcription quality — md-first + title (QUALITY)
Handwriting→doc transcription was plain and lossy.
- Improve `describeImage` prompt to return **markdown** (headings, `-`/`* ` lists, `- [ ]` checkboxes, bold) faithful to layout, not flattened text.
- For the **transcribe** flow (`/api/capture/transcribe`): after vision OCR, run the raw text through the **reasoning** model (`chat('reasoning')`) with a "clean into well-structured markdown + infer a concise title" prompt; create the doc with that title + markdown body. All transcriptions are markdown-first.

### 4. Memory review threshold + auto-review (QUALITY)
Most enrichment memories are good; we over-ask for review.
- Auto-review on creation when `confidence >= AUTO_REVIEW_THRESHOLD` (config, default 0.75): set `reviewed_at = now()` and DON'T add the `unreviewed` tag. Only low-confidence memories stay unreviewed.
- `reviewMemory(id)` (and auto-review) must **strip the `unreviewed` tag** from `tags` (and add `reviewed` optionally). The Memories UI unreviewed badge then reflects only genuinely-unreviewed.

### 5. Memory search relevance scores (QUALITY)
`searchMemories` should return a **relevance score** per result (the fused RRF score normalized 0–1, optionally reranked via `Qwen3-Reranker` at `:8883`). The Memories UI, when showing **search** results, displays relevance (not the stored confidence) — simulating how the MCP `search_memories` ranks. Add an optional reranker call behind a config flag (`AI_RERANK_BASE_URL`); fall back to RRF score if absent.

## Testing & validation
- Unit: tag-cap clamp; auto-review decision (confidence ≥ threshold → reviewed, no unreviewed tag); reviewed-tag strip is idempotent.
- Integration (rig): re-run OCR on a failed image → attempts increments, stops at 3 (no infinite loop); a transcribe of a list-style note yields markdown with lists/headings + an inferred title; a high-confidence enrichment memory lands reviewed; memory search returns relevance scores.
- Gates: typecheck/build/test.

## Non-goals
No UI rebuilds (the Memories UI relevance display is a small tweak; full search palette is cycle 8). Reranker is optional/flagged.

## Definition of done
OCR no longer loops on failures; tags capped 5–7; transcriptions are clean markdown with inferred titles; high-confidence memories auto-review and the unreviewed tag is removed on review; memory search exposes relevance scores. Wiki updates (enrichment.md, memory.md, image-hosting.md); handover; roadmap cycle-7 → shipped.
