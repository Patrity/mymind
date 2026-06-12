---
title: Image Hosting + Gallery
status: shipped
cycle: 20
updated: 2026-06-11
---

# Image Hosting + Gallery

ShareX/CleanShot-compatible image host: uploads auto-convert to webp, then run through a **status-driven enrichment pipeline** (one unified vision pass → summary + verbatim OCR + tags, a summary embedding for semantic search, library-based tag auto-apply, optional document spin-off). Images are browsed/edited in a gallery with public/private sharing and are first-class searchable via hybrid trigram + summary-vector search.

## Data model — `images` (`server/db/schema/images.ts`)
`id` · `storage_key` (content-addressed sha256, via storage abstraction) · `original_name` · `mime` · `ext` · `kind` (image|gif|video) · `width`/`height` · `size` · `ocr_text` · `summary` · `embedding` `halfvec(2560)` (summary embedding, **server-only**) · `enrich_status` (pending|processing|done|failed) · `enrich_error` · `enrich_attempts` int · `make_document` bool · `tags` text[] (confirmed) · `recommended_tags` text[] (library-unknown suggestions, awaiting approval) · `is_public` + `public_slug` (unique) · `created_at` · `deleted_at`.

Indexes (migration `0013_normal_darkhawk.sql`): GIN on `tags`; **HNSW cosine** on `embedding` (`images_embedding_hnsw`, `halfvec_cosine_ops`); trigram GIN on `ocr_text` and `summary` (`images_ocr_text_trgm`, `images_summary_trgm`). The same migration adds `documents.ocr_id` (the back-link from a spun-off document to its source image) and renames the old `ocr_attempts` column to `enrich_attempts`.

> `embedding` is **never serialized to the client**. `toImageDTO` (`server/services/images.ts`) destructures it out, so it is absent from `ImageDTO` (`shared/types/images.ts`).

## Enrichment pipeline — `server/services/image-enrich.ts`

### State machine (`enrich_status`)
`pending → processing → done | failed`. New uploads insert as `pending`. `enrichImage(id)` sets `processing` at the start of a run, then `done` on a real result or `failed` (recording `enrich_error`, truncated to 500 chars) on any error/empty result. Every failure increments `enrich_attempts`.

**Bounded retries:** the batch candidate predicate is `enrich_status = 'pending' OR (enrich_status = 'failed' AND enrich_attempts < MAX_ATTEMPTS)` where `MAX_ATTEMPTS = 3`. An image that fails 3 times is no longer picked up by the cron/admin batch (un-stick it with Reprocess or the admin backfill, which reset `enrich_attempts = 0`).

**Non-enrichable kinds:** `kind` not in `(image, gif)` (i.e. `video`) is marked `done` immediately with no model call — video is not vision-enriched. Images over `OCR_MAX_SIZE` (10 MB) are marked `done` without a vision call (existing `ocr_text` preserved).

**Enrich-first:** the vision model runs *before* anything is overwritten. Existing `summary`/`tags`/`ocr_text` are only replaced on a real (non-empty) vision result; an empty result preserves existing data and records the attempt as a (retryable) failure. Newly-confirmed tags are merged onto the existing `tags` (`capTags([...img.tags, ...confirmed], 50)`).

### Unified vision pass — `describeImageFull` (`server/lib/ai/vision.ts`)
One model call per image (`vision` usage via the cycle-12 registry resolver, `temperature 0.1`, `maxTokens 800`) returns **strict JSON** `{ summary, ocrText, tags }`:
- **summary** — one concise sentence (subject + nature).
- **ocrText** — ALL text transcribed verbatim as layout-faithful Markdown (headings, bullet/numbered lists, checkboxes, bold) **if the image has substantial text**; `""` otherwise.
- **tags** — 5–7 concise lowercase kebab-case tags (capped at 10).

`parseVisionResponse` is a pure, never-throwing parser (tolerant `{...}` extraction, strips markdown fences). `describeImageFull` returns all-empty on any failure rather than throwing.

### Library-based tag auto-apply — `server/services/tag-library.ts`
`buildTagLibrary()` returns the set of all distinct lowercase tags across live documents + images. `splitTags(suggested, library)` splits the vision tags into **confirmed** (already in the library → merged into `tags[]`) and **recommended** (library-unknown → `recommended_tags[]`, capped at 10, awaiting approval in the gallery).

### Summary embedding + revectorize
If the result has a non-empty `summary`, it is embedded (`embed([summary])`, 2560-dim) and stored in `embedding`. `revectorizeImage(id)` re-embeds the image's **current** summary only (no vision call) — used by the gallery Revectorize button; a blank summary clears `embedding` to null.

### Optional document spin-off
When `make_document` is true and the vision result has OCR text, the pipeline runs `cleanToMarkdown(ocrText)` and creates (or updates) a linked `/documents` row at `/input/<slug>-<nanoid>.md`, with `documents.ocr_id` pointing back at the image. The doc title falls back to `original_name` or `Scanned <date>`. Spin-off failure is non-fatal — image enrichment still completes.

## Hybrid image search — `searchImages` (`server/services/images.ts`)
Two ranked lanes fused with RRF (`rrfFuse`):
- **Lexical lane** — `ocr_text`/`summary` ILIKE + tag/recommended-tag array overlap, ordered by trigram `similarity(summary || ocr_text, q)`, top 50.
- **Vector lane** — `embedOne(q)` then cosine distance (`embedding <=> q::halfvec`) over rows with a non-null embedding, top 50. If the embedding rig is unreachable the lane is skipped (logged) and search degrades to lexical-only.

Fused ids are hydrated to full rows and re-ordered by fused rank. (`listImages` remains the plain lexical list used by the gallery's `?q=&tags=` filter.)

## Conversion — `server/lib/images/convert.ts`
`processUpload(buffer, mime, name)`: raster → webp q82 (`sharp.rotate()` applies EXIF orientation) with dims; animated gif → animated webp; `video/*` → passthrough (kind 'video'). Pure (no DB).

## Endpoints
| Method + path | Purpose |
|---|---|
| `POST /api/upload` | multipart (`file`) or raw binary. `?public=1`/`X-Public:1` → public immediately; `?makeDocument=1`/`?makeDocument=true`/`X-Make-Document:1` → sets `make_document` so enrichment spins off a linked doc. Auth: bearer API token or session. Returns `{ id, slug, url }`. |
| `GET /api/i/[slug]` | public, `is_public`-gated blob stream (auth-exempt prefix). |
| `GET /api/images/[id]/raw` | authed blob stream, any image. |
| `GET /api/images` | list w/ `url` (`?q=&tags=` filter). |
| `PATCH /api/images/[id]` | editable metadata — `summary`, `ocrText`, `tags`, `recommendedTags`, `isPublic` (public toggle owns slug generation separately). |
| `POST /api/images/[id]/reprocess` | full re-run of `enrichImage` (vision + tags + embed + optional doc) for one image. |
| `POST /api/images/[id]/revectorize` | re-embed the current summary only (no vision call). |
| `DELETE /api/images/[id]` | soft delete. |
| `POST /api/admin/ocr-run` | trigger `runImageEnrich({limit:20})` (same core as the cron). |
| `POST /api/admin/images-backfill` | mark images for (re)enrichment: `?all=1` re-queues everything, default re-queues only non-`done`; resets `enrich_status='pending'`, `enrich_attempts=0`, `enrich_error=null`. Returns `{ queued }`. |

Service: `server/services/images.ts`; enrichment core: `server/services/image-enrich.ts`.

## Cron — `enrich-images` (`server/tasks/enrich-images.ts`)
Nitro task scheduled `*/7 * * * *` (every 7 minutes; `nuxt.config.ts`). Calls `runImageEnrich({ limit: 20 })`, which selects up to 20 pending/retryable images, runs `enrichImage` on each, and reports `{ done, failed, remaining }`. The same `runImageEnrich`/`enrichImage` core also drives the admin `ocr-run` trigger and (after `images-backfill` re-queues) the backfill.

## Gallery — `app/pages/gallery.vue` / `app/composables/useImages.ts`
Thumbnail grid + detail modal. The modal surfaces the enrichment state and **editable metadata**:
- **Status badge** — colour-coded `enrich_status`; shows `enrich_error` when `failed`.
- **Editable summary / OCR text** — inline edit, dirty-checked PATCH on save (no save if unchanged).
- **Tags** — removable confirmed tags + custom tag add; recommended tags (Approve → moves to `tags`; Dismiss).
- **Reprocess** — full pipeline re-run (`POST .../reprocess`); **Revectorize** — re-embed current summary only (`POST .../revectorize`).
- Public toggle + copy URL, delete, upload.
- **Deep-link** — `/gallery?image=<id>` auto-opens that image's detail modal once per distinct value.

## Capture — `app/pages/capture.vue`
Note / Image tabs. The Image tab has an **"Also save as document"** toggle (default off) that sets `make_document` on upload, so enrichment spins off a linked `/documents` row from the OCR.

## Document ↔ image link — `app/components/documents/Editor.vue`
A document spun off from an image (has `ocr_id`) shows a **"View source image"** link to `/gallery?image=<ocrId>`.

## Follow-ups
Video→webm transcode + vision enrichment for video; EXIF privacy scrub; auto re-embed on summary edit (currently the explicit Revectorize button); OCR/enrich-failure → notification queue.
