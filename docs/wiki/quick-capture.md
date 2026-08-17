---
title: Quick Capture
status: shipped
cycle: 3
updated: 2026-08-16
mymind_id: b831487e-6419-4fa7-96ed-c9e655be5db1
mymind_hash: 09bf134e43b480748f564350b3c41ea3c6e0ac6b133b27941b65c3cb3a6989b0
---

# Quick Capture

The low-friction inbox: anything captured lands in `/input` and is organized afterward, out of band, by **capture triage** (cycle 57) — see "Why /input" below and [triage.md](triage.md).

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
Everything dropped here is fast to write and gets organized later, out of band, by **capture
triage** (cycle 57) rather than by the retired `enrich-input` frontmatter-proposal pipeline this
section used to describe. Triage infers what a jot actually *is* — a task, a durable memory, a
properly-renamed filed note, or an addition to a document that already covers the topic — and
routes it there: confident results apply on their own, genuine uncertainty lands in `/review`.
It fires immediately after `POST /api/capture/note` (fire-and-forget, so capture still returns
at write speed) plus a cron sweeper backstop that also covers the other `/input` inlets listed
above. All four confidence bars currently ship at `1.1` (above the max possible `1.0`), so
**nothing auto-applies yet** — every capture lands in `/review` while thresholds are calibrated
by hand. See [triage.md](triage.md) for the full pipeline, routing table, and actuators.
