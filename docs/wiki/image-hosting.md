---
title: Image Hosting + Gallery
status: shipped
cycle: 3
updated: 2026-06-03
---

# Image Hosting + Gallery

ShareX/CleanShot-compatible image host: uploads auto-convert to webp, get OCR text + recommended tags, and are browsed/managed in a gallery with public/private sharing.

## Data model — `images` (`server/db/schema/images.ts`)
`id` · `storage_key` (content-addressed sha256, via storage abstraction) · `original_name` · `mime` · `ext` · `kind` (image|gif|video) · `width`/`height` · `size` · `ocr_text` · `tags` text[] (confirmed) · `recommended_tags` text[] (OCR-suggested, awaiting approval) · `is_public` + `public_slug` (unique) · `created_at` · `deleted_at`. GIN index on tags.

## Conversion — `server/lib/images/convert.ts`
`processUpload(buffer, mime, name)`: raster → webp q82 (`sharp.rotate()` applies EXIF orientation) with dims; animated gif → animated webp; `video/*` → passthrough (kind 'video'; ffmpeg→webm is a follow-up). Pure (no DB).

## Endpoints
- `POST /api/upload` — multipart (`file`) or raw binary; `?public=1`/`X-Public:1` makes it public immediately. Auth: bearer API token or session. Returns `{ id, slug, url }`.
- `GET /api/i/[slug]` — public, `is_public`-gated, streams the blob (auth-exempt prefix). `GET /api/images/[id]/raw` — authed, any image.
- `GET /api/images` (list w/ `url`), `PATCH /api/images/[id]` (tags/recommendedTags/isPublic), `DELETE /api/images/[id]` (soft).
- Service: `server/services/images.ts`.

## OCR — `server/lib/ai/vision.ts` + `server/services/image-ocr.ts`
`describeImage(dataUrl)` → vision model (qwen3-vl-8b, OpenAI-spec structured content; prompt requests **markdown** + 5–7 tags) → `{ ocrText, tags }` (tolerant JSON). `runImageOcr()` fills `ocr_text` and sets `recommended_tags = capTags(splitTags(...).recommended, 10)` (library = distinct tags across documents+images). Never sets `tags`. Nitro task `ocr-images` (*/7) + `POST /api/admin/ocr-run`. **Bounded retries (cycle 7):** candidate query requires `ocr_attempts < 3` + `kind in (image,gif)`; success sets `ocr_text` (`''` sentinel = attempted), failure/empty increments `ocr_attempts` — no infinite re-scan when the vision model blips.

## Gallery — `app/pages/gallery.vue` / `app/composables/useImages.ts`
Thumbnail grid + detail modal: OCR text, removable confirmed tags, recommended tags (Approve → moves to `tags`; Dismiss), public toggle + copy URL, delete, upload.

## Cycle 10 polish
Gallery supports page-level drag-drop + clipboard-paste upload, renders `<video controls>` for `kind:'video'` items (file picker accepts mp4/webm/quicktime), and has an OCR+tag search box + `USelectMenu` multiselect tag filter (server `GET /api/images?q=&tags=`, parameterized).

## Per-image rescan (cleanup batch, 2026-06-11)
`POST /api/images/[id]/rescan` (`rescanImage` in `server/services/image-ocr.ts`) re-runs OCR for a single image, **enrich-first** so it never loses data: it runs the vision model *before* touching anything, and **only on a real result** clears `tags`/`recommended_tags`/`ocr_text` and writes fresh OCR + recommended tags (resetting `ocr_attempts`). On an empty/failed result it preserves existing tags and just bumps `ocr_attempts` (no data loss). A `kind` guard restricts it to `image`/`gif`. Because it resets `ocr_attempts`, it **un-sticks images that exhausted the `ocr_attempts < 3` cap** (the cron/admin batch runner skips those forever). A **Rescan** button sits in the gallery image detail-modal footer (bottom-right, next to Close).

## Follow-ups
Video→webm transcode; EXIF privacy scrub; OCR-failure → notification queue.
