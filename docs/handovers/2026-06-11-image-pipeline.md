---
title: Image Enrichment Pipeline (unified vision pass + summary embeddings + hybrid image search + editable metadata)
cycle: 20
date: 2026-06-11
status: shipped
spec: ../superpowers/specs/2026-06-11-image-pipeline-design.md
plan:
  - ../superpowers/plans/2026-06-11-image-pipeline.md
wiki: ../wiki/image-hosting.md
shipped:
  - "server/db/schema/images.ts — new columns: summary, embedding halfvec(2560) (summary embedding, server-only), enrich_status (default 'pending'), enrich_error, make_document (default false), and ocr_attempts RENAMED to enrich_attempts. server/db/schema/documents.ts — ocr_id uuid (back-link to a source image)."
  - "server/db/migrations/0013_normal_darkhawk.sql — the columns + the rename + indexes: HNSW cosine on embedding (images_embedding_hnsw, halfvec_cosine_ops) and trigram GIN on ocr_text + summary (images_ocr_text_trgm, images_summary_trgm)."
  - "server/lib/ai/vision.ts — describeImageFull: ONE unified vision pass (vision usage via the cycle-12 registry, temp 0.1, maxTokens 800) returning strict JSON {summary, ocrText, tags} — one-sentence summary + verbatim layout-faithful Markdown OCR (only if substantial text, else '') + 5–7 kebab-case tags. parseVisionResponse is a pure never-throwing parser (tolerant {...} extraction, fence-strip). Replaces the old describeImage."
  - "server/services/image-enrich.ts — enrichImage(id): the status-driven pipeline (pending→processing→done|failed, enrich_attempts++ on failure, MAX_ATTEMPTS=3). Enrich-first (vision runs before any overwrite; empty result preserves existing data + records a retryable failure). Non-enrichable kinds (video) → done with no model call; >10MB → done without vision. Library tag split, summary embed, optional doc spin-off. runImageEnrich({limit}) → {done, failed, remaining} over the pending/retryable predicate. revectorizeImage(id) re-embeds the CURRENT summary only."
  - "server/services/tag-library.ts — buildTagLibrary() (distinct lowercase tags across live docs+images) and splitTags(suggested, library) → {confirmed (library-known → tags[]), recommended (new → recommended_tags[])}."
  - "server/services/images.ts — searchImages(q): HYBRID image search — lexical lane (ocr/summary ILIKE + tag overlap, trigram-similarity ordered) + vector lane (embedOne(q) cosine over summary embedding, skipped/logged if rig unreachable) fused via RRF, hydrated + re-ordered by fused rank. toImageDTO REDACTS embedding (never serialized). patchImage (editable summary/ocr/tags). createImage takes opts.makeDocument."
  - "server/tasks/enrich-images.ts + nuxt.config.ts — Nitro task enrich-images on the schedule '*/7 * * * *' (every 7 min) → runImageEnrich({limit:20})."
  - "server/api/images/[id]/reprocess.post.ts (full re-run of enrichImage), revectorize.post.ts (re-embed current summary), index.patch.ts (summary/ocrText/tags/recommendedTags/isPublic). server/api/upload.post.ts — ?makeDocument=1|true / X-Make-Document:1 flag. server/api/admin/images-backfill.post.ts (?all=1 re-queues all, else non-done; resets enrich_attempts=0). server/api/admin/ocr-run.post.ts → runImageEnrich (same core as cron)."
  - "shared/types/images.ts — ImageDTO gains summary/enrichStatus/enrichError/enrichAttempts/makeDocument; NOTE embedding is NOT in the DTO (server-only)."
  - "app/pages/capture.vue — Note/Image tabs; Image tab 'Also save as document' toggle (default off) → sets make_document on upload. app/pages/gallery.vue — editable summary/ocr/tags, colour-coded enrich_status badge (+ enrich_error on failed), Reprocess vs Revectorize buttons, ?image=<id> deep-link auto-opens the detail modal. app/components/documents/Editor.vue — 'View source image' link to /gallery?image=<ocrId> when a doc has ocr_id."
verified:
  - "pnpm typecheck: PASS (green across all tasks)."
  - "pnpm test: PASS — 212 tests green (vision parser, tag split, enrich state machine, RRF fusion)."
  - "pnpm build: PASS (.output produced)."
  - "pnpm db:migrate: applied 0013_normal_darkhawk.sql clean (columns + ocr_attempts→enrich_attempts rename + HNSW/trigram indexes)."
  - "Live E2E (against the real homelab vision + embedding rigs, driven through the full server stack — auth middleware → endpoints → enrichImage worker → rigs → search): PASS (2026-06-12). Verified: upload → enrich_status 'pending' with no embedding in any DTO; Reprocess → live vision call populates summary + OCR + tag-split (library-known → tags[], new → recommended_tags[]); summary embedding written (halfvec, 2560 dims); makeDocument=1 → linked /input document created with documents.ocr_id + OCR content; PATCH summary/ocr/tags persists across a fresh GET (no embedding leak); Revectorize re-embeds (status done); a purely-semantic search query with ZERO lexical overlap returns the image via the vector lane; admin images-backfill (default + ?all=1) re-queues by resetting enrich_status/enrich_attempts/enrich_error while preserving summary/embedding/tags. An intermittent empty vision response was correctly recorded as a retryable 'failed' and recovered on retry — the status machine + enrich-first preservation behaved exactly as designed. (Driven via a temporary bearer API token against the running dev server rather than the browser UI; the UI was verified per-task by spec/quality review + build.)"
deferred:
  - "Gallery semantic search of images — SHIPPED this cycle (searchImages hybrid lexical+vector RRF); no longer deferred. Listed here only to mark it closed."
  - "No auto re-embed on summary edit — editing the summary via PATCH does NOT re-embed; the embedding is refreshed only by the explicit Revectorize button (or a full Reprocess). Intentional, to keep summary edits cheap and avoid a rig call on every keystroke-save."
  - "Video not vision-enriched — kind 'video' is marked done with no model call. Vision enrichment for video (and the video→webm transcode) remains a follow-up."
  - "searchImages full-row re-hydrate — the two ranked lanes select only ids, fuse via RRF, then re-fetch full rows by id and re-order in app code (inArray doesn't preserve order). Minor extra round-trip; fine at the current scale (top-50 lanes), worth folding into a single ranked query if image volume grows."
known_considerations:
  - "MAX_ATTEMPTS=3 stickiness — an image that fails enrichment 3 times is no longer picked up by the cron or admin ocr-run (the candidate predicate is pending OR failed-with-attempts<3). Un-stick it via the gallery Reprocess button (calls enrichImage directly, ignoring the cap) or POST /api/admin/images-backfill (resets enrich_attempts=0)."
  - "Enrich-first means empty vision results never destroy data — describeImageFull returns all-empty on any failure, and enrichImage treats an all-empty result as a retryable failure (preserves existing summary/tags/ocr, bumps enrich_attempts). Only a real result overwrites, and confirmed tags MERGE onto existing tags (capTags(...,50)) rather than replacing them."
  - "Embedding redaction — embedding (halfvec(2560)) must never reach the client. toImageDTO destructures it out, so it is absent from ImageDTO. Any new image read path must go through toImageDTO (or strip embedding) — selecting the raw row to the client would leak the vector."
  - "Vector lane degrades gracefully — searchImages wraps embedOne(q) + the cosine query in try/catch; if the embedding rig is unreachable the vector lane is skipped (logged) and search falls back to lexical-only rather than failing. So search keeps working without the rig, just without semantic recall."
  - "Doc spin-off is non-fatal and idempotent-ish — make_document spin-off reuses an existing linked doc (by documents.ocr_id) if present, else creates one. A spin-off failure is caught and logged; image enrichment still completes (status done). Toggling make_document after the first enrichment only takes effect on the next Reprocess/enrich run."
---

# Cycle 20 — Image Enrichment Pipeline (handover)

Replaced the ad-hoc image OCR flow (the old `describeImage` + an `ocr_text`-polling cron + the per-image `rescan` endpoint) with a **status-driven enrichment pipeline**. One unified vision pass per image produces a summary, verbatim layout-faithful OCR, and tags in a single strict-JSON call; the summary is embedded (`halfvec(2560)`, HNSW cosine) so images become first-class searchable via **hybrid trigram + vector RRF**. Tags are auto-applied against a cross-surface library, an optional document can be spun off from the OCR, and the whole metadata surface (summary / OCR / tags) is editable in the gallery with explicit Reprocess and Revectorize controls.

## What shipped (the 13 tasks at a glance)

1. **Schema + migration `0013`** — `images`: `summary`, `embedding halfvec(2560)`, `enrich_status`, `enrich_error`, `make_document`, and `ocr_attempts → enrich_attempts`; `documents.ocr_id`; HNSW cosine + trigram (ocr/summary) indexes.
2. **Unified vision pass** — `describeImageFull` + the pure `parseVisionResponse` (`server/lib/ai/vision.ts`).
3. **Tag library** — `buildTagLibrary` / `splitTags` (`server/services/tag-library.ts`).
4. **Enrichment core** — `enrichImage(id)` state machine (`server/services/image-enrich.ts`).
5. **Batch runner** — `runImageEnrich({limit})` over the pending/retryable predicate.
6. **Revectorize** — `revectorizeImage(id)` (re-embed current summary, no vision call).
7. **Summary embedding + redaction** — embed-on-result; `toImageDTO` strips `embedding`.
8. **Hybrid image search** — `searchImages` (lexical + vector lanes fused via RRF).
9. **Cron** — `enrich-images` Nitro task on `*/7 * * * *`.
10. **Per-image API** — `reprocess` / `revectorize` / `PATCH` (editable metadata) endpoints.
11. **Admin** — `images-backfill` (re-queue) + `ocr-run` (manual trigger) repointed at the shared core; `upload.post.ts` `makeDocument` flag.
12. **Capture** — Note/Image tabs + "Also save as document" toggle.
13. **Gallery + Editor** — status badge, editable summary/ocr/tags, Reprocess/Revectorize, `?image=` deep-link, "View source image" doc link.

## Architecture

**Status-driven, enrich-first.** Each image carries `enrich_status` (`pending → processing → done | failed`), `enrich_error`, and `enrich_attempts`. The cron (every 7 min) and the admin trigger both call `runImageEnrich`, which selects up to 20 images matching `pending OR (failed AND enrich_attempts < 3)` and runs `enrichImage` on each. `enrichImage` runs the vision model *before* touching stored data — only a real (non-empty) result overwrites, and confirmed tags merge onto existing tags, so a model blip never loses data. Video is marked `done` with no model call; >10 MB skips vision.

**One vision call, three outputs.** `describeImageFull` asks for strict JSON `{summary, ocrText, tags}` in a single request (summary sentence + verbatim Markdown OCR only when there's substantial text + 5–7 kebab tags). The parser is tolerant and never throws; failure yields all-empty (a retryable failure).

**Tags split against a live library.** `buildTagLibrary` is the distinct-tag set across live docs + images; `splitTags` routes library-known tags into `tags[]` (auto-applied) and new ones into `recommended_tags[]` (awaiting approval in the gallery).

**Summary embedding → hybrid search.** A non-empty summary is embedded (2560-dim) into `embedding` and indexed with HNSW cosine. `searchImages` runs a lexical lane (ocr/summary ILIKE + tag overlap, trigram-ordered) and a vector lane (cosine over the summary embedding), fuses them with RRF, and re-hydrates full rows. The vector lane degrades to lexical-only if the embedding rig is down. `embedding` is server-only and redacted from `ImageDTO`.

**Editable surface + explicit controls.** The gallery modal edits summary/OCR/tags (dirty-checked PATCH). **Reprocess** re-runs the whole pipeline (ignoring the attempt cap); **Revectorize** only re-embeds the current summary — there is deliberately no auto re-embed on a summary edit. Optional `make_document` spins off a linked `/documents` row (`documents.ocr_id` back-link), surfaced by a "View source image" link and the `?image=` gallery deep-link.

## Known considerations

- **`MAX_ATTEMPTS = 3` stickiness.** After 3 failures the cron/admin batch skips the image forever. Un-stick via the gallery **Reprocess** button (calls `enrichImage` directly, ignoring the cap) or `POST /api/admin/images-backfill` (resets `enrich_attempts = 0`).
- **Embedding redaction.** `embedding` must never reach the client; `toImageDTO` strips it. Any new read path must go through `toImageDTO` or it leaks the vector.
- **Vector lane is optional at runtime.** `searchImages` falls back to lexical-only if the embedding rig is unreachable, so search keeps working without semantic recall rather than erroring.
- **Doc spin-off is non-fatal + reuse-aware.** Spin-off reuses an existing linked doc by `ocr_id` else creates one; failure is logged and enrichment still completes. Flipping `make_document` after first enrichment only applies on the next Reprocess/enrich.
- **OPS: the `vision` usage is mis-assigned (config, not code).** During E2E the `vision` registry usage resolved to a *reasoning* MoE (`qwen3.6-35b-a3b` @ `192.168.2.25:8004`), **not** the dedicated vision model on `:8005`. It returns parseable JSON but hallucinates OCR detail (invents dates/watermarks) and intermittently emits empty `content` (output routed to a reasoning channel) → recorded as a retryable `failed`. Reassign the `vision` usage to the `:8005` vision model in `/settings` for accurate OCR/summaries. No code change needed — the resolver/pipeline behaved correctly against whatever was configured.
- **Vision-empty errors are attributed generically.** `describeImageFull` never throws (returns all-empty on any failure), so a model error and a genuinely-empty parse both surface as `enrich_error = 'vision returned empty result'`. Adequate for retry, but a future improvement could have `describeImageFull` surface the underlying cause for sharper diagnostics.

## Deferred

- **Gallery semantic image search — DONE this cycle** (hybrid lexical + vector RRF). Closed, not deferred.
- **No auto re-embed on summary edit** — refreshed only by the explicit **Revectorize** (or a full **Reprocess**). Intentional, to avoid a rig call on every save.
- **Video not vision-enriched** — `kind 'video'` is marked `done` with no model call; vision-for-video (and video→webm transcode) is a follow-up.
- **`searchImages` full-row re-hydrate** — the lanes select ids, RRF-fuse, then re-fetch + re-order full rows in app code (`inArray` loses order). Minor extra round-trip; acceptable at top-50 scale, foldable into one ranked query if volume grows.

## Next seam

1. **Merge:** gates are green (typecheck / test=212 / build / migrate) **and the live E2E against the real vision + embedding rigs passed** (upload → enrich → edit → Reprocess/Revectorize → semantic hybrid search → doc spin-off, all confirmed end-to-end). Ready to merge to master. CI auto-deploys master; migration `0013` runs on start. **Before relying on it in prod, reassign the `vision` usage in `/settings` to the dedicated `:8005` vision model** (see Known considerations) — the pipeline is correct but the currently-assigned reasoning MoE gives weak OCR.
2. **Capture/OCR robustness (cycle 15, planned)** is the natural follow-on — explicit dedup + transcription retry surfaced to the notification queue now layers cleanly onto this status machine (`enrich_status='failed'` + `enrich_error` is the queue source).
3. **Video enrichment + video→webm transcode** is the remaining media gap — `enrichImage` already short-circuits video to `done`, so it's a clean place to add a video path.
