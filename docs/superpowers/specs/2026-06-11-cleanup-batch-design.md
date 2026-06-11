---
title: Cleanup batch — clipboard layout/previews, gallery rescan, AI-config follow-ups
date: 2026-06-11
status: spec
supersedes: none
related:
  - ../../handovers/2026-06-10-ai-config-registry.md
---

# Cleanup batch (post cycle 12)

Four independent, contained work items. None are architectural. Bundled because they're all small polish/fix tasks; each lands in its own commit. Done before starting cycle 13 (API key management UI).

**Conventions:** Nuxt 4 + Nuxt UI v4, app under `app/`, server under `server/`. Semantic color tokens only. Gates: `pnpm typecheck`, `pnpm test`, `pnpm build`; E2E via `playwright-cli` (not MCP). Lint is NOT a gate.

---

## Item 1 — Clipboard layout: pin navbar, scroll the body

**Problem.** `app/pages/clipboard.vue` renders its loading/error/main content as the **default slot** of `UDashboardPanel` instead of `<template #body>`. Other pages (`settings.vue`, `tasks.vue`, etc.) put content in `#body`, which `UDashboardPanel` makes the scroll region under the pinned `#header` navbar. Because clipboard skips `#body`, a long paste history grows the panel and pushes the navbar off-screen.

**Fix.**
- Move the three content blocks (loading, error, `v-else-if="threadId"` main UI) into `<template #body>` of the `UDashboardPanel`.
- Inside `#body`, structure as a column where the message **Thread** is the `flex-1 overflow-y-auto` scroll region and the **Composer** is pinned at the bottom (does not scroll). Verify `ClipboardThread`'s message list actually scrolls internally (add `overflow-y-auto` / `min-h-0` where needed so the flex child can shrink).
- The navbar (`#header`) stays fixed at top; only the message list scrolls.

**Consistency pass.** Audit the other 11 main pages' `UDashboardPanel` usage and confirm each follows "navbar in `#header`, content in `#body`". The audit found only clipboard is wrong; fix any other offenders found, but do not refactor working pages. Standalone pages (`login`, `onboarding`, `share/[slug]`, all `layout: false`) are intentionally exempt — do not touch.

**Out of scope.** Centralizing the navbar into `default.vue` (rejected — each page has its own `#right` toolbar actions, dynamic titles, and `documents`/`voice` use two panels/navbars).

**Verify.** `playwright-cli`: on `/clipboard` with enough messages to overflow, the navbar stays visible at the top while the message list scrolls; the composer stays pinned at the bottom.

---

## Item 2 — Clipboard image/video previews

**Problem.** `app/components/clipboard/MessageBubble.vue:39` computes `isImage` from `props.message.attachment?.mimeType`, but the server DTO (`server/services/clipboard.ts`, `ClipAttachmentDTO`) and the DB column are named `mime` (not `mimeType`). So `attachment.mimeType` is always `undefined`, `isImage` is always `false`, and every attachment — including png/jpg/webp/gif/mp4 — renders as a generic file card with a download icon instead of an embedded preview.

**Fix (align the client on `mime`, the server/DB source of truth — smaller blast radius than renaming the DTO).**
- In `app/components/clipboard/Thread.vue` and `MessageBubble.vue`, change the attachment interface field from `mimeType` to `mime` (and any other client interface that declares `mimeType` for a clip attachment).
- `MessageBubble.vue`: `isImage = computed(() => attachment?.mime?.startsWith('image/') ?? false)`.
- Add `isVideo = computed(() => attachment?.mime?.startsWith('video/') ?? false)`.
- Render branches: `image/*` → existing `ClipboardMessageImage` (embedded image); `video/*` → a `<video controls>` (mp4/webm) — add a small `ClipboardMessageVideo` component (or an inline `<video>` branch) mirroring the image component's sizing/styling; otherwise → `ClipboardMessageFile`.
- Confirm the image/video `src` uses the same storage URL the file card already links to (the download href), so no new endpoint is needed.

**Verify.** `playwright-cli`: upload/paste a png and an mp4 to a clipboard thread; the png shows an inline image, the mp4 shows a `<video>` player; a non-media file still shows the file card.

---

## Item 3 — Gallery rescan button (eager re-enrichment)

**Goal.** A per-image "Rescan" that re-runs AI tagging + OCR on demand, clearing any existing results first. Fixes prod images stuck with `ocrAttempts >= 3` + null `ocrText` (which the 7-minute `ocr-images` cron and the admin batch runner permanently skip).

**Server — new endpoint `POST /api/images/[id]/rescan`.**
- Add `rescanImage(id)` in `server/services/images.ts` (or co-locate with the OCR service). Steps:
  1. Load the image; 404 if missing/deleted.
  2. Clear `tags = []`, `recommendedTags = []`, `ocrText = null`, `ocrAttempts = 0`.
  3. **Eagerly** run the vision model for this one image (reuse `describeImage(dataUrl)` from `server/lib/ai/vision.ts`, the same path `runImageOcr` uses), then write the resulting `ocrText` + split tags (confirmed vs recommended) exactly as `runImageOcr` does for a single image. Increment `ocrAttempts` on empty/failed result, consistent with the existing soft-failure handling.
  4. Return the updated `ImageDTO`.
- `describeImage` never throws (returns empty on failure); the endpoint should still return the (cleared, attempt-incremented) DTO on a failed enrichment so the UI reflects reality, and surface a soft error message. Reuse the existing helper that builds the image `dataUrl` from storage that `runImageOcr` uses (do not duplicate storage-read logic — extract/share if needed).

**Client.**
- `useImages()` (`app/composables/useImages.ts`): add `rescan(id) => $fetch('/api/images/' + id + '/rescan', { method: 'POST' })` returning the updated DTO.
- `app/pages/gallery.vue` detail modal footer (currently Delete on the left, Close on the right): add a **Rescan** button on the bottom-right **next to Close** (`icon: i-lucide-refresh-cw`, loading spinner while running). On success, update the selected image / refresh the modal so new tags + OCR render. Reuse the existing `withMutate`/refresh pattern used by the tag approve/remove handlers.

**Confirmed-tags note.** Per the user, rescan clears existing `tags` (confirmed) as well as `recommendedTags` and `ocrText` before re-running — a full redo, not an append.

**Out of scope (YAGNI).** A bulk "re-enrich all stuck images" action. (The per-image button is the agreed surface; a bulk pass can be a follow-up if needed.)

**Verify.** `playwright-cli`: open an image with existing tags, click Rescan, confirm tags/OCR clear and repopulate (against the real vision rig); unit test the endpoint (clears the four fields, calls enrichment, returns updated DTO).

---

## Item 4 — AI-config (cycle 12) follow-ups

Five minor items from the cycle-12 final review. Each is small and independent.

1. **`finish()` error handling** — `app/pages/onboarding.vue`: wrap the `finish()` body (`save → refresh → navigate`) in try/catch so a failed save (e.g. dim-probe 422) doesn't produce an unhandled promise rejection; surface `config.error` (it already renders inside the embedded AssignmentsTab, but the page should handle it explicitly). Navigate only on success.
2. **`save()` refreshes onboarding status** — `app/composables/useAiConfig.ts`: after a successful `save()` (and its re-`load`), call `useAiConfigStatus().refresh()` so removing the last `reasoning`/`embeddings` assignment re-arms the onboarding gate without a full page reload.
3. **Guard `import-env` overwrite** — `server/api/settings/import-env.post.ts`: before building from `emptyDoc()` and saving, load the existing config; if it already has any assignments (i.e. not empty), return a 422 (`"config already exists; import only seeds an empty registry"`) instead of destroying it. Keeps the one-time-seed semantics safe.
4. **Clearer dim-probe message** — `server/api/settings/ai-config.put.ts`: distinguish "embedding model returned the wrong number of dimensions" from "embedding endpoint unreachable". The current catch labels a resolved-but-wrong-dims case with "(model unreachable?)". Branch the message on the actual failure (wrong-dim count vs fetch/timeout error).
5. **Dedupe client `2560`** — `app/components/settings/ModelForm.vue` and `app/components/settings/AssignmentsTab.vue` each hardcode `2560`. Share one `EMBEDDING_DIM` constant (a small client constant module under `app/`, or a shared export consumable client-side) so the embedding dimension lives in one place. Do not import server-only modules into client code.

**Verify.** Unit test the `import-env` guard (422 when config non-empty). Typecheck + build. The onboarding/save behaviors are covered by the existing manual E2E flow; spot-check `finish()` error surfacing.

---

## Cross-cutting

- **Order:** items are independent; suggested order is 4 (quick wins) → 2 → 1 → 3, but any order works. One commit per item (item 4 may be one commit or a few small ones).
- **No DB migration** is required (all fields in items 3/4 already exist).
- **Docs:** update the clipboard and gallery wiki pages if their behavior descriptions change; note the rescan endpoint. The cycle-12 follow-ups are small enough to fold into the existing AI-config wiki/handover rather than a new handover.
