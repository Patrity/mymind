---
title: Image enrichment pipeline — unified vision pass, summary embeddings, editable metadata
date: 2026-06-11
status: spec
supersedes: none
related:
  - ../../handovers/2026-06-10-ai-config-registry.md
  - ./2026-06-11-cleanup-batch-design.md
---

# Image enrichment pipeline

Replace the ad-hoc image OCR flow (two capture entry points + a `ocrText IS NULL` polling cron) with a real, status-driven enrichment pipeline: one unified vision pass per image (summary + verbatim OCR + tags), a **summary embedding** for semantic search, library-based tag auto-apply, optional document spin-off, and a fully editable metadata surface in the gallery. Makes images first-class searchable (hybrid trigram + vector) instead of lexical-only.

**Conventions:** Nuxt 4 + Nuxt UI v4, app under `app/`, server under `server/`. Drizzle/pg + pgvector (`halfvec(2560)`, HNSW cosine). AI model access via the cycle-12 registry resolver (`withFailover(usage, …)`). Semantic tokens only in `.vue`. Gates: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm db:migrate`; E2E via `playwright-cli`. Lint is NOT a gate.

---

## Problem (current state)

- **Two capture entry points, no pipeline.** Capture has Note / Image / Transcribe tabs. "Image" → `POST /api/upload` (image row only). "Transcribe" → upload + `POST /api/capture/transcribe` which creates a separate **document** from the image's OCR. Gallery upload is a third path.
- **Enrichment is a polling sentinel, not a state machine.** `runImageOcr` (7-min cron `ocr-images`) selects images where `ocrText IS NULL AND ocrAttempts < 3 AND kind IN ('image','gif')`, calls `describeImage` (returns `{ocrText, tags}`), writes `ocrText` + `recommendedTags`. "Needs processing" is encoded as `ocrText IS NULL` — there is no status, no observability, and stuck images (attempts ≥ 3) are skipped forever.
- **No vectors for images.** `images` has no embedding column; image search is **lexical only** (`ocrText ILIKE` + tag array overlap in `server/services/search.ts`). Documents/memories are hybrid (trigram + `halfvec(2560)` vector, RRF-fused). An untagged image with null OCR is effectively unsearchable, and "dog" never matches a "puppy" tag.
- **No editing.** The gallery modal shows OCR read-only and offers approve/dismiss/remove on tags. There is no way to edit OCR text, write a summary, or add a custom tag.

---

## Locked decisions (from brainstorm)

1. **Image embeds its summary, not its OCR text.** Full-text semantic search rides the linked document (below); the image vector matches on visual/semantic description. Avoids double-embedding the same text and duplicate image+doc hits.
2. **Transcription still creates a document, linked by `documents.ocr_id → images.id`.** The doc embeds the full text (docs already do this well); the doc page links back to the source image.
3. **Tag auto-apply uses the tag library, not LLM relevance.** Tags already in the user's library (any tag used on a live doc/image) auto-apply to `tags`; new tags go to `recommendedTags` for review. No model-reported relevance score (poorly calibrated; flickers). Consistent with the locked "auto-review high-confidence, human-review low-confidence" rule.
4. **The capture toggle = "Also save as document" (default OFF).** Every image always gets the unified vision pass (summary + tags + OCR-if-text), stored on the image. The toggle only controls whether a linked `/documents` row is ALSO spun off. (Labeled "Also save as document", not "Transcribe", since OCR always happens.)
5. **Status-driven worker on existing cron infra — no new queue dependency.** A `enrich_status` state machine replaces the `ocrText IS NULL` sentinel.

---

## Data model

### `images` — new/changed columns (`server/db/schema/images.ts`)
- `summary text` — one-sentence visual/semantic description (nullable until enriched).
- `embedding halfvec(2560)` — embedding **of the summary**. HNSW cosine index (mirror the documents index).
- `enrichStatus text not null default 'pending'` — `pending | processing | done | failed`.
- `enrichError text` — last failure reason (nullable).
- `enrichAttempts integer not null default 0` — retry counter. **Replaces `ocrAttempts`** (rename/repurpose in the migration).
- `makeDocument boolean not null default false` — persists the capture toggle so the async worker knows whether to spin off a document.

Keep: `ocrText`, `tags`, `recommendedTags`, `kind`, etc. Remove the `ocrText IS NULL`-as-status semantics.

### `documents` — new column (`server/db/schema/documents.ts`)
- `ocrId uuid` (nullable, references `images.id`) — links a transcription-derived doc to its source image.

### Migration
One Drizzle migration: add the columns above, add the HNSW index on `images.embedding`, add `documents.ocr_id`. Existing image rows default to `enrich_status='pending'` (the worker will reprocess them — only a handful exist; no automatic bulk job). `pnpm db:migrate` locally; CI migrates prod.

---

## The pipeline

### `enrichImage(id)` — the shared worker core (`server/services/image-enrich.ts`, new; supersedes `image-ocr.ts`)
One function runs the whole pipeline for a single image. It is the shared core behind **three callers**: the cron batch, the **Reprocess** button, and the **backfill** admin endpoint. Never throws; on any step failure it sets `enrich_status='failed'`, records `enrich_error`, increments `enrich_attempts`, and preserves existing data (enrich-first — don't wipe tags/summary on a failed re-run). Returns the updated row (or null if missing/deleted).

Steps:
1. Load the live image; set `enrich_status='processing'`. Guard: only `kind IN ('image','gif')` get the vision call (videos get `status='done'` with empty enrichment — no model call).
2. **Unified vision call** — `describeImageFull(dataUrl) → { summary, ocrText, tags }` (extends `server/lib/ai/vision.ts`). Reuses the storage→dataUrl helper (`readImageDataUrl`) and the `vision` registry usage via `withFailover`. Oversized images (> `OCR_MAX_SIZE`) skip the call.
3. **Tag split** (`splitTags`, existing): library-matched tags → `tags`; new tags → `recommendedTags` (capped via `capTags`). On a re-run, merge — do not silently drop user-confirmed tags.
4. **Document spin-off** — if `makeDocument` is true AND `ocrText` is non-empty, create a `documents` row from the OCR markdown with `ocrId = image.id`, **reusing the existing `capture/transcribe` doc-creation logic** (path/location + frontmatter). Since capture is now async (no user-entered title), derive the title from the first Markdown heading in `ocrText`, falling back to the image `originalName`, falling back to `"Scanned <createdAt date>"`. The new doc enters the normal document embedding flow (existing `runEmbedding` cron embeds it — `enrichImage` does NOT embed the doc, only the image summary). If a doc already exists for this image (match on `ocr_id`), update its content rather than duplicating.
5. **Embed the summary** — `embed([summary])` (existing `embeddings` registry usage + failover), write `images.embedding`. Skip if `summary` is empty.
6. `enrich_status='done'`, clear `enrich_error`.

### Vision prompt (`describeImageFull`)
Extends the current OCR prompt to return three fields in strict JSON:
> "Describe this image in one concise sentence (subject + nature) as `summary`. If the image contains substantial text, transcribe ALL of it verbatim as Markdown faithful to the source layout (headings, lists, checkboxes, bold) into `ocrText`; if it has little/no text, set `ocrText` to "". Suggest 5–7 concise lowercase kebab-case tags (max 10). Respond as STRICT JSON only: `{"summary": string, "ocrText": string, "tags": string[]}`. No prose."

Parse: reuse `extractJson` + type-check all three fields; on parse failure return `{ summary:'', ocrText:'', tags:[] }` (treated as an empty result → `failed` + attempt bump, existing data preserved).

### Cron worker (`server/tasks/enrich-images.ts`, replaces `ocr-images.ts`)
Selects up to N images where `enrich_status='pending' OR (enrich_status='failed' AND enrich_attempts < MAX_ATTEMPTS)`, runs `enrichImage` on each. Schedule stays in `nuxt.config.ts` (e.g. the existing `*/7 * * * *`). Update the admin trigger (`server/api/admin/ocr-run.post.ts` → `enrich-run`) accordingly.

### Lighter operation: `revectorizeImage(id)`
Re-embed the **current** (possibly user-edited) `summary` only → `embedding`. No vision call. Backs the **Revectorize** button (user edits the summary, then refreshes search vectors).

---

## Capture changes (`app/pages/capture.vue`)

- Remove the **Transcribe** tab. Tabs become **Note** and **Image**.
- Image mode gains an **"Also save as document"** `USwitch` (default off) → passed to upload as `makeDocument`.
- Upload (`POST /api/upload`) inserts the image `pending` (+ `makeDocument`) and **returns immediately** — no synchronous vision wait. The worker enriches in the background; capture just confirms "saved".
- Retire `server/api/capture/transcribe.post.ts` (its doc-creation logic now lives in `enrichImage` step 4). `POST /api/upload` gains an optional `makeDocument` flag (query or body).

---

## Gallery detail modal (`app/pages/gallery.vue`)

- **Summary** — new editable `UTextarea`.
- **OCR text** — editable `UTextarea` (was read-only).
- **Tags** — keep approve/dismiss on `recommendedTags`, remove on `tags`; **add a custom-tag input** (type → add to `tags`).
- **Status** — a small badge from `enrich_status` (processing / failed / done); show `enrich_error` on failure.
- **Buttons:** **Reprocess** (renames Rescan → `enrichImage(id)` full re-run), **Revectorize** (`revectorizeImage(id)`), plus existing Delete / Close.
- Persist edits via `PATCH /api/images/[id]` extended to accept `summary`, `ocrText`, `tags`, `recommendedTags`. Editing the summary then clicking Revectorize is the "rewrote the description → refresh search" path.

---

## Search (`server/services/search.ts` + the hybrid path)

Add an **images lane to the hybrid search**: vector search over `images.embedding` (summary) RRF-fused with the existing lexical match (`ocrText ILIKE` + tag overlap), mirroring how documents/memories fuse trigram + vector. The global `searchAll` images query swaps lexical-only for the fused version. Embed the query once (reuse the `embeddings` usage) and fuse via the existing RRF utility.

---

## Endpoints (new / changed)

| Route | Action | Responsibility |
|---|---|---|
| `POST /api/images/[id]/reprocess` | Rename of `rescan` | `enrichImage(id)` full re-run; returns ImageDTO |
| `POST /api/images/[id]/revectorize` | Create | `revectorizeImage(id)` — re-embed current summary; returns ImageDTO |
| `PATCH /api/images/[id]` | Extend | accept `summary`, `ocrText`, `tags`, `recommendedTags` |
| `POST /api/upload` | Extend | optional `makeDocument`; insert `pending`, return immediately |
| `POST /api/admin/images-backfill` | Create | mark all (or all non-`done`) images `pending` for the worker; not run by default |
| cron `ocr-images` → `enrich-images` | Replace | status-driven batch over `pending`/retryable-`failed` |

`ImageDTO` gains `summary`, `enrichStatus`, `enrichError`, `enrichAttempts`, `makeDocument` (embedding is server-only, never serialized). `documents` DTO/relations gain `ocrId` + a "source image" link on the doc page.

---

## Testing

- **Pure unit (vitest, fits the existing harness):** `splitTags` (exists), the `describeImageFull` JSON parse (extend the existing vision parse test for the 3-field shape + malformed input), tag-merge-on-edit logic, status-transition helper (pending→processing→done/failed).
- **Not unit-tested (no DB/endpoint harness — matches cycle-12 precedent):** the worker, endpoints, and search are verified via `pnpm typecheck` + `pnpm build` + live `playwright-cli` E2E against the real rigs (capture → background enrich → summary/tags/OCR appear; edit + Revectorize; Reprocess; semantic image search returns a non-lexical match; transcription toggle creates a linked doc; backfill marks pending).
- Keep the existing 207 tests green.

---

## Out of scope (YAGNI)

- A real job-queue dependency (pg-boss/Bull) — the status machine on the existing cron suffices at this volume.
- Auto re-embed on summary edit via a content hash — the explicit **Revectorize** button covers it (unlike documents, image summaries change rarely and only by hand).
- Persisting per-tag relevance scores — relevance is a transient ingestion signal, not stored.
- Bi-directional image↔doc sync — the doc is an editable derivative; the image keeps the original scan + its OCR. They intentionally diverge after creation.
- Re-running the pipeline for video `kind` — videos are stored but not vision-enriched.

---

## Decisions log (for future readers)

- **Embed summary, not OCR** — full text is searchable via the linked document; keeps image vectors about visual content and avoids duplicate hits.
- **Library auto-apply over LLM relevance** — stable, deterministic signal aligned with the existing confirmed-vs-recommended model and the AI-safety rule.
- **Toggle = "also make a document"** — OCR is free in the unified call, so always capture it; the toggle only governs the heavier document spin-off.
- **One `enrichImage` worker, not two (vision + embed) like documents** — per-image steps are sequential; one pass is more legible. Embed-only failures re-run vision on retry (acceptable; Revectorize covers the standalone re-embed case).
- **Status machine over `ocrText IS NULL`** — observable, retryable, un-sticks the prod images the old sentinel skipped forever.
