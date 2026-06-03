---
title: Quick Capture
status: shipped
cycle: 3
updated: 2026-06-03
---

# Quick Capture

The low-friction inbox: anything captured lands in `/input` and rides the cycle-2 enrichment pipeline (auto-embed + LLM frontmatter proposals into the review queue).

## UI — `app/pages/capture.vue`
Three tabs (sidebar nav "Capture", `i-lucide-plus`, top of menu):
- **Note** — textarea + optional title → `POST /api/capture/note` → creates `/input/<slug>.md`.
- **Image** — file picker / camera (`accept=image/* capture=environment`) + optional public → `useImages().upload`.
- **Transcribe** — upload an image → `POST /api/capture/transcribe` → vision OCR → creates `/input/transcribed-<id>.md` with the recognized text.

## Endpoints
- `server/api/capture/note.post.ts` — `{ text, title? }` → `createDoc({ path: '/input/<slug>.md', title, content: text })`. Slug derived from title (kebab, ≤64) or nanoid.
- `server/api/capture/transcribe.post.ts` — `{ imageId, title? }` → `getImage` → blob → data URL → `describeImage` (markdown-first OCR) → **`cleanToMarkdown` (cycle 7)** runs the raw OCR through the reasoning model (`server/lib/ai/transcribe.ts`) to produce faithful markdown (headings/lists/checkboxes/bold) + an inferred title → `createDoc({ path:'/input/<title-slug>-<nanoid>.md', title, content: markdown })`. Blank/no-text images create a stub gracefully.

## Why /input
Everything dropped here is automatically embedded and gets LLM-proposed frontmatter (project/domain/type/tags + a destination path) into the review queue — so capture is fast and organization happens later via Approve. See [enrichment.md](enrichment.md).
