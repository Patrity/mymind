# Interaction Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** UX polish across Capture, Gallery, Tasks, Memories, Clipboard (paste/camera/drag-drop, search/filters, task DnD, manual memory, machine attribution).

**Tech Stack:** Nuxt 4 + Nuxt UI v4, VueUse (`useUserMedia`, `useDropZone`, installed), existing APIs (`/api/upload`, `/api/images`, tasks/memory/clipboard). Reuse cycle-9 paste-image pattern.

---

### Task 1: Capture — paste + camera + drag-drop
**Files:** `app/pages/capture.vue`, `app/components/CameraCapture.vue` (new).
- [ ] `CameraCapture.vue`: a `UModal` using VueUse `useUserMedia` — live `<video>` preview, "Capture" snaps to a `<canvas>` → `toBlob` → emits a `File`. Handle no-permission/no-camera gracefully (message).
- [ ] On the **image** + **transcribe** tabs: add (a) a paste handler (`@paste` → clipboard image → File), (b) a "Use camera" button opening `CameraCapture`, (c) a drag-drop zone (`useDropZone`) accepting image files. All three feed the same handler that the tab already uses (image → `useImages().upload`; transcribe → upload then `/api/capture/transcribe`).
- [ ] typecheck + build. Commit.

### Task 2: Gallery — drag/paste upload + video + search + tag filter
**Files:** `app/pages/gallery.vue`, `app/composables/useImages.ts`, maybe `server/api/images/index.get.ts` (add q/tags query).
- [ ] Page-level drag-drop (`useDropZone` on the page root) + paste handler → `upload(file)` (private by default) → refresh. Friendly toast on rejected type (the API returns 415).
- [ ] Render video items: when `img.kind === 'video'` (or mime starts video/), render `<video controls :src="img.url">` instead of `<img>`. Upload file picker `accept="image/*,video/mp4,video/webm,video/quicktime"`.
- [ ] Search + tag filter: a search `UInput` (filters by ocr_text/tags) + a `USelectMenu` multiselect of existing tags. Implement client-side filter over the loaded list OR extend `/api/images?q=&tags=` — prefer a server query for scale: `GET /api/images?q=&tags=a,b` filtering ocr_text ilike + tags overlap. Update `useImages().list(params)`.
- [ ] typecheck + build. Commit.

### Task 3: Tasks — drag-drop + filters
**Files:** `app/pages/tasks.vue`.
- [ ] Native HTML5 DnD: task cards `draggable`, the 4 columns are drop targets → on drop `move(id, { status: columnStatus })` → refresh; visual column hover. Keep the status select as a fallback or remove it (feedback called it corny — remove or hide behind the DnD).
- [ ] Filters row: project `USelect` (from `useProjects`) + priority `USelect` (low/medium/high/all) → filter the board (client-side over loaded tasks, or pass to `list({project})`). 
- [ ] typecheck + build. Commit.

### Task 4: Memories — add modal + tag filter
**Files:** `app/pages/memories.vue`, `app/composables/useMemories.ts`, `server/api/memories/index.post.ts` (new if missing).
- [ ] `POST /api/memories` → `createMemory({ content, scope, project?, tags?, reviewed:true })` (manual memories are reviewed). Add the route if it doesn't exist.
- [ ] "Add memory" button → `UModal` (content `UTextarea`, scope `USelect` user/agent/world, project `UInput`, tags input) → create → refresh.
- [ ] Tag filter: a `USelectMenu` multiselect of tags present in the list → filter displayed memories (client-side or pass to `/api/memories?tags=`).
- [ ] typecheck + build. Commit.

### Task 5: Clipboard — machine attribution
**Files:** `app/components/clipboard/MessageBubble.vue` (+ maybe `Thread.vue`), `server/api/clipboard/threads/[id]/messages.get.ts` (join device label), `server/services/clipboard.ts` (include device label in message DTO).
- [ ] `listMessages` returns each message with its `deviceLabel` (join `clip_devices` on `device_id`). 
- [ ] `MessageBubble.vue`: show the device label in the caption (e.g. "MacBook · 11:42") — like copipasta. Keep the current-device right/other left split.
- [ ] typecheck + build. Commit.

### Task 6: validation + handover + merge
- [ ] Gates typecheck/build/test.
- [ ] playwright-cli: Gallery drag/paste upload + tag filter + a video renders; Tasks drag a card between columns + filter; Memories add-modal creates one + tag filter; Capture camera modal opens (note camera permission limits); Clipboard shows a device label. Screenshot each major one.
- [ ] Handover; wiki (quick-capture/image-hosting/tasks-projects/memory/clipboard); roadmap cycle-10 → shipped. Final review (focus: upload type allowlist holds for video; no XSS via device label / tag filter; DnD bubbling). Merge.

---

## Self-Review
Coverage: Capture paste/camera/drag (T1) ✓ · Gallery drag/paste/video/search/tag-filter (T2) ✓ · Tasks DnD+filters (T3) ✓ · Memories add-modal+tag-filter (T4) ✓ · Clipboard attribution (T5) ✓ · validation/docs/merge (T6) ✓. Reuses upload/images/tasks/memory/clipboard + VueUse. Camera can't be fully headless-validated (note it). Video already stored passthrough (cycle 3) — this renders it.
