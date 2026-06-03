---
title: Quick Capture + Image Hosting/Gallery
cycle: 3
status: spec
date: 2026-06-03
supersedes: none
---

# Cycle 3 — Quick Capture + Image Hosting/Gallery

## Purpose
Make it frictionless to get things into MyMind: a ShareX/CleanShot-compatible image host (auto-converted to webp, OCR-tagged) with a gallery, and a Quick Capture surface for notes/ideas (drop into `/input`, ride the cycle-2 enrichment) and image capture (upload or camera), including transcribing hand-written notes into documents.

## Locked decisions (roadmap)
Env-configured providers; vision/OCR = local `qwen3-vl-8b` (`:8005`); every AI mutation reviewable (recommended tags require approval); storage via the existing `server/utils/storage` abstraction.

## Components

### Image data model + storage
- `images` table: `id` uuid, `storage_key` text (content-addressed, from storage `put`), `original_name`, `mime`, `ext`, `kind` ('image'|'gif'|'video'), `width`, `height`, `size`, `ocr_text` text, `tags` text[] (confirmed), `recommended_tags` text[] (OCR-suggested, awaiting approval), `is_public` bool, `public_slug` text unique, `created_at`, `deleted_at`.
- Conversion: `server/lib/images/convert.ts` — sharp converts raster images → webp (quality ~82), captures width/height; animated gif → webp (animated) or passthrough; video → passthrough store as-is this cycle (ffmpeg→webm is a documented follow-up). Returns processed buffer + metadata.

### Upload + serve
- `POST /api/upload` — accepts multipart (`file` field) AND raw binary body (ShareX `Body=Binary`). Auth: bearer **API token** (machine clients) OR session. Runs conversion, `storage.put`, inserts `images` row, returns JSON `{ url, slug, id }` where `url` is the public/serve URL (ShareX `$json:url$`). A ShareX config snippet documented in the handover.
- `GET /api/i/[slug]` — serves the stored blob (public if `is_public`, else 401/404); sets correct content-type; auth-exempt prefix `/api/i` for public reads (checks `is_public`). Private images served via an authed route.
- Default visibility configurable; per scope, images are private by default, toggle to public.

### OCR / tagging
- `server/lib/ai/vision.ts` — `describeImage(buffer|url): { text, tags[] }` calling the vision model (`aiProvider('vision')`, OpenAI-spec chat with an image content part, base64 data URL). Strict-ish JSON: `{ ocrText, tags }`.
- `server/services/image-ocr.ts` `runImageOcr({limit})` + Nitro task `ocr-images` + `POST /api/admin/ocr-run`: for images with null `ocr_text`, call `describeImage`; store `ocr_text`; split suggested tags into **confirmed-candidates** (those already in the tag library — union of existing `documents.tags` + `images.tags`) vs **recommended** (new). Store recommended on `recommended_tags`. NEVER auto-add to `tags`. On OCR failure, leave `ocr_text` null and (optionally) enqueue a `review_queue` row kind `ocr-failed`.

### Gallery UI
- `app/pages/gallery.vue` — responsive grid of image thumbnails (served webp). Click → detail drawer/modal: full image, OCR text, `tags` (removable), `recommended_tags` (each Approve → moves to `tags`; Dismiss → removes from recommended), public/private toggle (shows copy-able public URL), delete. Sidebar nav "Gallery" (`i-lucide-image`).

### Quick Capture
- `app/pages/capture.vue` (and/or a global modal) — fast entry:
  - **Note**: a textarea → `POST /api/capture/note` → creates a doc at `/input/<timestamped-or-titled>.md` (rides cycle-2 enrichment automatically).
  - **Image**: file picker / camera (`<input capture>`) → `/api/upload`.
  - **Transcribe**: an image flagged "transcribe handwriting" → vision OCR → creates an `/input` doc with the transcribed text (so it gets enriched/filed). 
  - Sidebar nav "Capture" (`i-lucide-plus`) or a prominent button.

## Testing & validation
- Unit (vitest): conversion picks webp for raster + reports dims (sharp on a generated test PNG buffer); tag-split logic (library-match vs recommended) is pure-testable; vision JSON parse tolerant.
- Integration (real rig + sharp/ffmpeg): upload a PNG via `/api/upload` → stored as webp, row created, serve URL returns image; run OCR → `ocr_text` + recommended tags populated by the real vision model; capture a note → `/input` doc created.
- `playwright-cli`: Gallery renders an uploaded image; approve a recommended tag moves it to confirmed; Quick Capture note creates a doc.
- Gates: `pnpm typecheck && pnpm build && pnpm test`.

## Non-goals (later/cycles)
Video→webm transcoding (passthrough now; ffmpeg follow-up); EXIF stripping/privacy scrub (note as a security follow-up); image editing; albums/collections.

## Definition of done
ShareX/CleanShot can upload to MyMind and get a shareable URL; images auto-convert to webp and get OCR text + recommended tags awaiting approval; a gallery browses/manages them with public/private; Quick Capture drops notes/transcriptions into `/input`. Wiki: add `image-hosting.md` + `quick-capture.md`; handover; roadmap cycle-3 → shipped.
