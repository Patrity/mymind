# Quick Capture + Image Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** ShareX/CleanShot-compatible image host (webp conversion + OCR tagging + gallery, public/private) and a Quick Capture surface (notes → `/input`, image upload, handwriting transcription → `/input`).

**Architecture:** `images` table + the existing storage abstraction; sharp for webp; a Nitro OCR task using the vision model fills `ocr_text` + `recommended_tags` (never auto-confirmed); gallery + capture UIs.

**Tech Stack:** Nuxt 4, Drizzle/Postgres, sharp 0.34, ffmpeg (present, video deferred), qwen3-vl-8b (`:8005`), Vitest, playwright-cli.

**Validation env:** rig reachable (vision 8005 with key from `.env`); sharp + ffmpeg installed.

---

### Task 1: images schema + conversion lib
**Files:** `server/db/schema/images.ts` (+ barrel), migration; `server/lib/images/convert.ts`; `test/convert.test.ts`.
- [ ] `images` table per spec (storage_key, mime, ext, kind, width/height, size, ocr_text, tags[], recommended_tags[], is_public, public_slug unique, created_at, deleted_at). Migrate; verify.
- [ ] `pnpm add sharp`. `convert.ts`: `processUpload(buffer, mime, name) -> { buffer, mime, ext, kind, width, height }` — raster→webp (q82) with dims; gif→webp(animated) or passthrough; video/* → passthrough (kind 'video'). TDD a test that feeds a generated solid-color PNG buffer (sharp can create one) and asserts output mime `image/webp` + correct dims + kind 'image'.
- [ ] typecheck + test + commit.

### Task 2: upload + serve endpoints
**Files:** `server/services/images.ts` (create/list/get/setPublic/delete via storage+db), `server/api/upload.post.ts`, `server/api/i/[slug].get.ts` (public), `server/api/images/[id]/raw.get.ts` (authed private), `server/api/images/index.get.ts` (list), `server/api/images/[id]/*` (patch tags/public, delete).
- [ ] `/api/upload`: accept multipart (`readMultipartFormData`) and raw body; `processUpload`; `storage.put`; insert row (private by default); return `{ id, slug, url }`. Auth via existing middleware (bearer token or session). Add `/api/i` to the middleware PUBLIC_PREFIXES (public reads).
- [ ] `/api/i/[slug]`: look up by public_slug + is_public; stream blob from storage with content-type. `/api/images/[id]/raw`: authed, any image.
- [ ] Smoke: upload a PNG with a bearer token → returns url; GET the url returns image bytes; row shows ext webp. Commit.

### Task 3: vision OCR tagging (validate vs rig)
**Files:** `server/lib/ai/vision.ts`, `server/services/image-ocr.ts`, `server/tasks/ocr-images.ts`, `server/api/admin/ocr-run.post.ts`, `test/tag-split.test.ts`.
- [ ] `vision.ts` `describeImage(dataUrl)`: `chat('vision', [{role:'user', content:[{type:'text',...},{type:'image_url',image_url:{url:dataUrl}}]}])`-style OpenAI vision message; parse `{ ocrText, tags }` (tolerant). (Confirm the vision content-part shape the vLLM endpoint accepts.)
- [ ] pure `splitTags(suggested, library)` → `{ confirmed, recommended }` (library-match vs new). TDD it.
- [ ] `runImageOcr({limit})`: for images with null ocr_text, build a data URL from the stored blob, `describeImage`, store `ocr_text`, `recommended_tags = splitTags(...).recommended` (do NOT touch `tags`). Nitro task `ocr-images` + `POST /api/admin/ocr-run`. On failure leave ocr_text null + console.warn.
- [ ] Validate vs rig: upload a screenshot with text, run ocr-run, confirm `ocr_text` + `recommended_tags` populated by the real vision model. Commit.

### Task 4: Gallery UI
**Files:** `app/pages/gallery.vue`, `app/composables/useImages.ts`, sidebar nav.
- [ ] `useImages`: list/get/setPublic/patchTags/approveRecommended/dismissRecommended/remove.
- [ ] `gallery.vue`: responsive thumbnail grid (served webp); detail modal/drawer: full image, ocr_text, tags (removable chips), recommended_tags (Approve→tags / Dismiss), public toggle + copy URL, delete. Sidebar "Gallery" nav.
- [ ] typecheck + build + commit.

### Task 5: Quick Capture
**Files:** `app/pages/capture.vue`, `server/api/capture/note.post.ts`, `server/api/capture/transcribe.post.ts`, sidebar nav.
- [ ] `/api/capture/note`: body `{ text, title? }` → `createDoc({ path: '/input/<slug-or-timestamp>.md', title, content: text })` (rides enrichment).
- [ ] `/api/capture/transcribe`: body references an uploaded image id (or accepts upload) → `describeImage` → `createDoc({ path:'/input/transcribed-<ts>.md', content: ocrText })`.
- [ ] `capture.vue`: tabs — Note (textarea → note), Image (file/camera `<input accept="image/*" capture>` → /api/upload), Transcribe (image → transcribe). Sidebar "Capture" nav + prominent button.
- [ ] typecheck + build; quick functional check (note creates an /input doc). Commit.

### Task 6: E2E + handover + merge
- [ ] Gates: typecheck/build/test.
- [ ] playwright-cli: upload via gallery (or capture) shows an image in the gallery; approve a recommended tag; capture a note → appears under /input in Documents. Screenshot.
- [ ] Rig recap: image stored as webp; OCR text + recommended tags from the real model.
- [ ] Handover (+ deferrals: video transcode, EXIF scrub); wiki `image-hosting.md` + `quick-capture.md`; roadmap cycle-3 → shipped. Final holistic review; fix blockers; merge to master.

---

## Self-Review
Coverage: images model+webp (T1) ✓ · ShareX upload + serve + public/private (T2) ✓ · OCR tags confirmed-vs-recommended, nothing auto-confirmed (T3) ✓ · gallery (T4) ✓ · quick capture notes/image/transcribe → /input (T5) ✓ · validation/docs/merge (T6) ✓. Pure units extracted (processUpload dims, splitTags). Security follow-ups noted (EXIF scrub, public-read prefix). Video transcode explicitly deferred.
