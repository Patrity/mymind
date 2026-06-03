---
title: Quick Capture + Image Hosting/Gallery
cycle: 3
status: shipped
date: 2026-06-03
shipped:
  - images table + sharp webp conversion (raster->webp q82 with EXIF rotate + dims; animated gif->webp; video passthrough)
  - ShareX/CleanShot-compatible POST /api/upload (multipart + raw binary; ?public=1 / X-Public:1 flag); bearer-token or session auth
  - Public serve GET /api/i/[slug] (auth-exempt, is_public-gated) + authed GET /api/images/[id]/raw; list/patch/delete management routes
  - Vision OCR (server/lib/ai/vision.ts describeImage via qwen3-vl-8b) -> ocr_text + recommended_tags; splitTags confirmed-vs-recommended (library match); Nitro task ocr-images (*/7) + POST /api/admin/ocr-run. VALIDATED vs rig (read "Invoice Total 4200" + tags)
  - Gallery UI (grid, detail modal: OCR text, removable confirmed tags, recommended tags Approve/Dismiss, public toggle + copy URL, delete)
  - Quick Capture (app/pages/capture.vue): Note -> /input doc; Image -> /api/upload; Transcribe -> vision OCR -> /input doc. Notes/transcriptions ride the cycle-2 enrichment pipeline.
deferred:
  - "Video -> webm transcoding (ffmpeg is installed; videos currently passthrough). Follow-up."
  - "EXIF/metadata privacy scrub on upload (sharp.rotate() applies orientation but full EXIF strip not enforced) -> security follow-up before exposing uploads publicly at scale"
  - "Login form submit didn't navigate in one browser-sim run (worked via API; cycle-2 E2E showed the form working) -> verify it's just a dev hydration race, not a regression"
  - "OCR/upload do not yet enqueue review_queue 'ocr-failed' items on failure (just console.warn + null ocr_text) -> wire into the notification queue later"
  - "No albums/collections, no image editing, no dedupe-UI (storage is content-addressed so identical bytes dedupe at rest)"
next_seam: "Cycle 4 (Tasks + Projects / Kanban): self-contained, no AI. projects table already exists (cycle 1); add tasks table (status/priority/due/audit) + kanban UI + doc<->project<->domain relations. Then cycle 5 (Memory + MCP) reuses the chat helper + embeddings + review-queue patterns."
validation: "typecheck + build + 37 vitest tests; playwright-cli E2E (gallery render, recommended-tag approve, public URL served anon, capture note in /input, transcribe doc); real-rig: image stored webp, OCR text + recommended tags from qwen3-vl-8b."
---

# Cycle 3 — Quick Capture + Image Hosting/Gallery (handover)

MyMind is now an image host + low-friction inbox. ShareX/CleanShot can upload and get a shareable URL; images auto-convert to webp and get OCR text + recommended tags (awaiting approval — `tags` is never auto-filled); a gallery manages them; Quick Capture drops notes and handwriting transcriptions into `/input` to ride enrichment.

## ShareX config (custom uploader)
- Request URL: `https://<host>/api/upload?public=1`
- Method: POST, Body: form-data (or Binary), file form name: `file`
- Headers: `Authorization: Bearer <api-token>` (create a row in `api_tokens`)
- Response → URL: `$json:url$`

## Key decisions / deviations
- **webp everywhere** for raster + gif; **video passthrough** this cycle (ffmpeg→webm deferred).
- **Nothing auto-confirms**: OCR suggestions land in `recommended_tags`; the gallery's Approve moves one into `tags` (mirrors the cycle-2 review surface, inline per-image).
- Vision uses OpenAI-spec structured content (`image_url:{url:data...}`) against qwen3-vl-8b — worked first try.
- Storage is content-addressed (sha256 key) → identical uploads dedupe at rest.

## Where things live
- Images: `server/db/schema/images.ts`, `server/services/images.ts`, `server/lib/images/convert.ts`, `server/api/{upload.post,i/[slug].get}.ts`, `server/api/images/*`.
- OCR: `server/lib/ai/vision.ts`, `server/services/image-ocr.ts`, `server/tasks/ocr-images.ts`, `server/api/admin/ocr-run.post.ts`.
- Capture: `server/api/capture/{note,transcribe}.post.ts`, `app/pages/capture.vue`. Gallery: `app/pages/gallery.vue`, `app/composables/useImages.ts`.
