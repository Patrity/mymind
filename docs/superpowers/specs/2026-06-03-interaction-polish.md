---
title: Interaction Polish
cycle: 10
status: spec
date: 2026-06-03
feedback: ../../scope-feedback.md
---

# Cycle 10 — Interaction Polish

## Purpose
Round-2 UX polish across five surfaces, all from feedback. No new backend models (reuses upload/images/tasks/memory/clipboard APIs + VueUse).

## Items (from scope-feedback.md)

### Capture
- **Paste image** on the `image` and `transcribe` tabs (clipboard image → upload / transcribe).
- **Camera capture** on `image` and `transcribe` (desktop + mobile) via VueUse `useUserMedia` — a capture modal: live `<video>` preview, snap → canvas → blob → upload (or transcribe).
- **Drag-and-drop** images onto the image/transcribe drop area.

### Gallery
- **Drag-and-drop** images anywhere on the page to upload (VueUse `useDropZone` on the page).
- **Paste** an image from the clipboard to upload.
- **File-type handling**: confirm the upload allowlist (already rejects non-image/video from cycle-3 hardening) and surface a friendly error on rejected types.
- **Video support**: accept + render video files (mp4/webm/quicktime — already stored as `kind:'video'` passthrough); the gallery renders `<video controls>` for video items; the upload file picker accepts video.
- **Search bar** (ocr_text + tags) + a `USelectMenu` **multiselect tag filter** (filter the grid by selected tags). Reuse/extend the `/api/images` list or add a query.

### Tasks
- **Drag-and-drop** cards between columns (replace the corny status dropdown) → `moveTask(id, {status})`. Native HTML5 DnD between the 4 columns.
- **Filters**: project (`USelect`) + priority (`USelect`) at the top, filtering the board.

### Memories
- **Add-memory modal**: a button opening a `UModal` to manually add a memory (content, scope, project?, tags) → `POST /api/memories` (add the create route if missing) → `createMemory` (manual, reviewed=true so it's not "unreviewed").
- **Tag filter**: a tag multiselect to filter the memory list.

### Clipboard
- **Machine attribution**: messages show which machine/device they came from (like `copipasta`) — a device label on each bubble. Needs device labels surfaced (the `clip_devices` table has `label`); the bubble shows the label, not just left/right split.

## Testing & validation
- Mostly playwright-cli interaction validation per surface; unit where pure (e.g. tag-filter predicate).
- Camera: validate the `useUserMedia` modal opens + the snap→upload path compiles (headless can't grant camera; verify wiring + a manual note).
- Gates: typecheck/build/test.

## Non-goals
Video transcoding (still passthrough); image editing; per-device management UI (just show labels); multi-select bulk actions in the gallery.

## Definition of done
Capture supports paste/camera/drag-drop; Gallery supports drag/paste upload + video + search + tag filter; Tasks supports drag-drop + project/priority filters; Memories has a manual add modal + tag filter; Clipboard shows machine attribution. Wiki updates (quick-capture, image-hosting, tasks-projects, memory, clipboard); handover; roadmap cycle-10 → shipped.
