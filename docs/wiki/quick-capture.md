---
title: Quick Capture
status: shipped
cycle: 3
updated: 2026-06-03
---

# Quick Capture

The low-friction inbox: anything captured lands in `/input` and rides the cycle-2 enrichment pipeline (auto-embed + LLM frontmatter proposals into the review queue).

## UI — `app/pages/capture.vue`
**Two** tabs (sidebar nav "Capture", `i-lucide-plus`, top of menu):
- **Note** — textarea + optional title → `POST /api/capture/note` → creates `/input/<slug>.md`.
- **Image** — file picker / camera (`accept=image/* capture=environment`) + optional public → `useImages().upload`.

> **Removed:** a third **Transcribe** tab and `POST /api/capture/transcribe` (image → vision OCR → `/input/transcribed-<id>.md`) existed in cycles 3–7 and were **deleted on 2026-06-12** in `8e96834` ("refactor(images): remove legacy ocr/transcribe/cron"). This page went on describing them as live for two months, and that staleness misled the cycle-57 brainstorm into speccing work against an endpoint that does not exist. Image enrichment now lives in the image pipeline, not in capture.

## Endpoints
- `server/api/capture/note.post.ts` — `{ text, title? }` → `createDoc({ path: '/input/<slug>.md', title, content: text })`. Slug derived from title (kebab, ≤64) or nanoid.

## What else lands in `/input`
Capture is not the only inlet, which is why triage has a sweeper and not just a post-capture hook:
- MCP `quick_capture` → `/input/<slug>.md` (`server/lib/agent/tools.ts`).
- MCP `save_document` with no `project` → falls through to `/input`.
- Any direct `POST /api/documents` with an `/input/…` path.

## Cycle 10 polish
The Image tab accepts input three ways: clipboard **paste**, **camera** capture (`CameraCapture.vue` via VueUse `useUserMedia`; works desktop + mobile), and **drag-drop** — all feeding the same upload handler. (The Transcribe tab this originally also covered was removed in `8e96834`; see above.)

## Why /input
Everything dropped here is automatically embedded and gets LLM-proposed frontmatter (project/domain/type/tags + a destination path) into the review queue — so capture is fast and organization happens later via Approve. See [enrichment.md](enrichment.md).
