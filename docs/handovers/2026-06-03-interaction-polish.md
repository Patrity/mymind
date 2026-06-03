---
title: Interaction Polish
cycle: 10
status: shipped
date: 2026-06-03
feedback: ../../scope-feedback.md
shipped:
  - "Capture: CameraCapture modal (VueUse useUserMedia, stream stopped on close) + paste image + drag-drop on the image & transcribe tabs."
  - "Gallery: page-level drag-drop + paste upload (415 → friendly toast), video rendering (<video controls> for kind=video, file picker accepts mp4/webm/quicktime), search (ocr_text + tags) + USelectMenu multiselect tag filter (server query ?q= & ?tags=, parameterized)."
  - "Tasks: drag-and-drop cards between columns (removed the per-card status dropdown) + project & priority filters (non-empty sentinels)."
  - "Memories: manual add-memory modal (POST /api/memories → createMemory reviewed:true, no unreviewed tag) + tag multiselect filter."
  - "Clipboard: message bubbles show the originating machine/device label in the caption ('<label> · HH:MM') via a leftJoin in listMessages."
deferred:
  - "Camera capture, card DnD, and drag/paste uploads can't be simulated in headless playwright — validated by wiring + API; work in a real browser."
  - "Tag filters (gallery client-derived options; memories client-side filter) derive options from the loaded list — fine at single-user scale; a dedicated tags endpoint could be added later."
  - "Video is still passthrough (no transcode); the gallery just renders it."
next_seam: "Cycle 11 (Sessions view) is the last round-2 item: browse raw CC/Hermes transcripts (sessions + messages already ingested in cycle 5) + token usage / message count / tool-use stats. Read-only views over the sessions/messages tables; consider capturing usage/tool metadata in the hook ingestion."
validation: "typecheck + build + 128 tests; playwright across all 5 surfaces: gallery search/tag-filter + a video renders; tasks dropdown removed + priority filter works; memories add-modal creates a reviewed memory + tag filter; capture camera modal opens (permission-denied graceful headless); clipboard shows device labels. curl: /api/images?q=/?tags= filter, manual memory reviewed=true, deviceLabel join."
---

# Cycle 10 — Interaction Polish (handover)

Round-2 batch 4: UX polish across five surfaces, all reusing existing APIs + VueUse (no new data models; one new route `POST /api/memories`).

## Per-surface
- **Capture**: paste / camera (`useUserMedia`) / drag-drop on image + transcribe tabs (`CameraCapture.vue`).
- **Gallery**: drag/paste upload, `<video>` rendering, OCR+tag search + multiselect tag filter (server `?q=`/`?tags=`).
- **Tasks**: native DnD between columns (the "corny" status select is gone) + project/priority filters.
- **Memories**: manual add modal (reviewed, source `manual`) + tag filter.
- **Clipboard**: per-message machine attribution (device label in caption), copipasta-style.

## Where things live
`app/pages/{capture,gallery,tasks,memories}.vue`, `app/components/CameraCapture.vue`, `app/components/clipboard/MessageBubble.vue`, `server/services/{clipboard,images,memory}.ts`, `server/api/images/index.get.ts` (q/tags), `server/api/memories/index.post.ts` (new), `app/composables/{useImages,useMemories}.ts`.
