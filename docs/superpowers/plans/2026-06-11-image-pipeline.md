# Image Enrichment Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc image OCR cron with a status-driven enrichment pipeline: one unified vision pass per image (summary + verbatim OCR + tags), a summary embedding for hybrid search, library-based tag auto-apply, optional linked-document spin-off, and a fully editable gallery metadata surface.

**Architecture:** A single `enrichImage(id)` worker runs the whole pipeline for one image (vision → tag-split → optional doc → embed summary), driven by a `enrich_status` state machine. It's the shared core behind the cron, the Reprocess button, and a backfill endpoint. Images gain a `halfvec(2560)` summary embedding and join the hybrid (trigram + vector RRF) search. Capture goes async (insert `pending`, return immediately).

**Tech Stack:** Nuxt 4, Nuxt UI v4, Drizzle/pg + pgvector (`halfvec(2560)`, HNSW cosine), the cycle-12 AI registry resolver (`withFailover`), `playwright-cli` E2E.

**Branch:** create `feat/image-pipeline` off `master` before Task 1. Merge back when done (CI auto-deploys `master` on push, so don't push master mid-flight). Spec: `docs/superpowers/specs/2026-06-11-image-pipeline-design.md`.

**Conventions:** Semantic color tokens only in `.vue`. Gates: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm db:migrate`. Lint is NOT a gate (red repo-wide) — commit with `--no-verify` if a pre-commit hook blocks. UI verified with `playwright-cli` (not MCP). Dev server typically runs on `:3000`. **Test reality:** the vitest suite is pure-logic only (no DB/endpoint harness); DB/endpoint/worker code is verified via typecheck + build + live E2E, matching the cycle-12 precedent. Keep the existing 207 tests green.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/db/schema/images.ts` | Modify | Add `summary`, `embedding halfvec(2560)`, `enrichStatus`, `enrichError`, `makeDocument`; rename `ocrAttempts`→`enrichAttempts` |
| `server/db/schema/documents.ts` | Modify | Add `ocrId uuid` |
| `server/db/migrations/00NN_*.sql` | Create (generated + hand-edited) | Columns + HNSW + trigram indexes |
| `server/lib/ai/vision.ts` | Modify | Add `parseVisionResponse` (pure) + `describeImageFull` (summary+ocr+tags) |
| `server/services/image-enrich.ts` | Create | `enrichImage(id)`, `revectorizeImage(id)`, helpers (moved from image-ocr.ts) |
| `server/tasks/enrich-images.ts` | Create | Status-driven cron worker (replaces `ocr-images.ts`) |
| `nuxt.config.ts` | Modify | Cron `ocr-images`→`enrich-images` |
| `server/api/admin/ocr-run.post.ts` | Modify | Call the new worker (rename intent → `enrich-run`) |
| `server/services/images.ts` | Modify | `createImage` takes `makeDocument`; add `searchImages(q)` hybrid; `patchImage` for summary/ocr/tags |
| `server/api/upload.post.ts` | Modify | Accept `makeDocument`; insert `pending` |
| `server/api/images/[id]/reprocess.post.ts` | Create (rename of rescan) | `enrichImage(id)` |
| `server/api/images/[id]/revectorize.post.ts` | Create | `revectorizeImage(id)` |
| `server/api/images/[id]/rescan.post.ts` | Delete | superseded by reprocess |
| `server/api/images/[id]/index.patch.ts` | Modify | Accept `summary`/`ocrText`/`tags`/`recommendedTags` |
| `server/services/search.ts` | Modify | Images lane → `searchImages` hybrid |
| `app/composables/useImages.ts` | Modify | `reprocess`/`revectorize`/`patch summary,ocr`/custom tag |
| `app/pages/capture.vue` | Modify | Drop Transcribe tab; "Also save as document" toggle |
| `app/pages/gallery.vue` | Modify | Editable summary/ocr/tags, status badge, Reprocess/Revectorize |
| `app/pages/documents.vue` (or doc view) | Modify | "View source image" link when `ocrId` set |
| `server/api/admin/images-backfill.post.ts` | Create | Mark images `pending` |
| `server/services/image-ocr.ts` | Delete (cleanup) | superseded by image-enrich.ts |
| `server/api/capture/transcribe.post.ts` | Delete (cleanup) | logic moved into worker |
| `shared/types/images.ts`, `shared/types/search.ts` | Modify | DTO additions |
| `test/vision-parse.test.ts` | Create | Unit-test `parseVisionResponse` |

---

### Task 0: Branch

- [ ] **Step 1:** `cd /Users/tony/Documents/GitHub/mymind && git checkout -b feat/image-pipeline`
Expected: new branch off `master`.

---

### Task 1: Schema + migration

**Files:** Modify `server/db/schema/images.ts`, `server/db/schema/documents.ts`; Create a migration; touch `server/services/image-ocr.ts` references.

- [ ] **Step 1: Update `server/db/schema/images.ts`**

Read the file first. Add the `halfvec` import (mirror documents.ts: `import { halfvec } from '../types/halfvec'`). In the `images` table add these columns (place near `ocrText`):

```ts
  summary: text('summary'),
  embedding: halfvec(2560),
  enrichStatus: text('enrich_status').notNull().default('pending'),
  enrichError: text('enrich_error'),
  makeDocument: boolean('make_document').notNull().default(false),
```

Rename the existing `ocrAttempts` column field to `enrichAttempts` and its db name to `enrich_attempts`:
```ts
  enrichAttempts: integer('enrich_attempts').notNull().default(0),
```
(Remove the old `ocrAttempts: integer('ocr_attempts')...` line.) Ensure `boolean` is imported from `drizzle-orm/pg-core`.

- [ ] **Step 2: Update `server/db/schema/documents.ts`**

Add a nullable column (near `publicSlug`):
```ts
  ocrId: uuid('ocr_id'),
```
(`uuid` is already imported.)

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `server/db/migrations/00NN_*.sql` adding the columns + rename. Inspect it — drizzle-kit may emit `ALTER TABLE images RENAME COLUMN "ocr_attempts" TO "enrich_attempts"` OR a drop+add. If it emits drop+add for the rename, **hand-edit it** to a single `ALTER TABLE "images" RENAME COLUMN "ocr_attempts" TO "enrich_attempts";` (retry counts are disposable, but a rename is cleaner). 

- [ ] **Step 4: Hand-add the HNSW + trigram indexes to the generated migration**

Append to the new migration SQL (mirror `0003`'s document index pattern):
```sql
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS images_embedding_hnsw ON images USING hnsw (embedding halfvec_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS images_ocr_text_trgm ON images USING gin (ocr_text gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS images_summary_trgm ON images USING gin (summary gin_trgm_ops);
```

- [ ] **Step 5: Keep `image-ocr.ts` building (it references the renamed column)**

In `server/services/image-ocr.ts`, find/replace every `images.ocrAttempts` → `images.enrichAttempts` and `ocrAttempts:` set-keys → `enrichAttempts:` (the candidate query `lt(images.ocrAttempts, 3)`, the increments, etc.). This keeps the doomed file compiling until it's deleted in cleanup.

- [ ] **Step 6: Migrate + verify**

Run: `pnpm db:migrate && pnpm typecheck`
Expected: migration applies; typecheck PASS.

- [ ] **Step 7: Commit**
```bash
git add server/db/ && git commit --no-verify -m "feat(images): schema — summary, embedding, enrich state machine, documents.ocr_id"
```

---

### Task 2: Unified vision call (`describeImageFull`) + pure parse

**Files:** Modify `server/lib/ai/vision.ts`; Create `test/vision-parse.test.ts`.

The current `describeImage` returns `{ ocrText, tags }`. Add a pure parse function + a `describeImageFull` returning `{ summary, ocrText, tags }`. Keep `describeImage` for now (image-ocr.ts still uses it until cleanup).

- [ ] **Step 1: Write the failing test** — `test/vision-parse.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parseVisionResponse } from '../server/lib/ai/vision'

describe('parseVisionResponse', () => {
  it('parses summary, ocrText, and tags from clean JSON', () => {
    const raw = '{"summary":"A dog on a couch","ocrText":"","tags":["dog","couch"]}'
    expect(parseVisionResponse(raw)).toEqual({ summary: 'A dog on a couch', ocrText: '', tags: ['dog', 'couch'] })
  })
  it('strips markdown fences', () => {
    const raw = '```json\n{"summary":"x","ocrText":"hi","tags":[]}\n```'
    expect(parseVisionResponse(raw)).toEqual({ summary: 'x', ocrText: 'hi', tags: [] })
  })
  it('coerces missing/invalid fields to empty', () => {
    expect(parseVisionResponse('{"tags":"nope"}')).toEqual({ summary: '', ocrText: '', tags: [] })
  })
  it('returns all-empty on unparseable input', () => {
    expect(parseVisionResponse('not json')).toEqual({ summary: '', ocrText: '', tags: [] })
  })
  it('caps tags at 10', () => {
    const tags = Array.from({ length: 15 }, (_, i) => `t${i}`)
    expect(parseVisionResponse(JSON.stringify({ summary: '', ocrText: '', tags })).tags.length).toBe(10)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`parseVisionResponse` not exported). Run: `pnpm test vision-parse`

- [ ] **Step 3: Implement in `server/lib/ai/vision.ts`**

Add a new interface + exported pure parser, reusing the existing `extractJson` and `capTags`:
```ts
export interface VisionFull {
  summary: string
  ocrText: string
  tags: string[]
}

/** Pure parser for the unified vision response. Never throws. */
export function parseVisionResponse(raw: string): VisionFull {
  const empty: VisionFull = { summary: '', ocrText: '', tags: [] }
  const parsed = extractJson(raw)
  if (!parsed) return empty
  const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
  const ocrText = typeof parsed.ocrText === 'string' ? parsed.ocrText : ''
  const rawTags = Array.isArray(parsed.tags)
    ? (parsed.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : []
  return { summary, ocrText, tags: capTags(rawTags, 10) }
}
```

Then add `describeImageFull` (mirror `describeImage`, new prompt, uses the parser):
```ts
/**
 * Unified vision pass: one-sentence summary + verbatim OCR (if substantial text) + tags.
 * Never throws — returns all-empty on any failure.
 */
export async function describeImageFull(dataUrl: string): Promise<VisionFull> {
  const empty: VisionFull = { summary: '', ocrText: '', tags: [] }
  try {
    const messages = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: 'Describe this image in one concise sentence (subject + nature) as "summary". If the image contains substantial text, transcribe ALL of it verbatim as Markdown faithful to the source layout (headings #/##, bullet lists -, numbered lists 1., checkboxes - [ ]/- [x], **bold**) into "ocrText"; if it has little or no text, set "ocrText" to "". Also suggest 5–7 concise lowercase kebab-case tags describing the content (max 10). Respond as STRICT JSON only: {"summary": string, "ocrText": string, "tags": string[]}. No prose.'
          },
          { type: 'image_url' as const, image_url: { url: dataUrl } }
        ]
      }
    ]
    const raw = await chat('vision', messages as ChatMessage[], { temperature: 0.1, maxTokens: 800 })
    return parseVisionResponse(raw)
  } catch (err) {
    console.warn('[vision] describeImageFull failed:', err)
    return empty
  }
}
```

- [ ] **Step 4: Run the test — expect PASS.** Run: `pnpm test vision-parse`. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add server/lib/ai/vision.ts test/vision-parse.test.ts
git commit --no-verify -m "feat(vision): describeImageFull (summary+ocr+tags) + pure parseVisionResponse + tests"
```

---

### Task 3: `enrichImage` worker + `revectorizeImage`

**Files:** Create `server/services/image-enrich.ts`.

This is the pipeline core. It moves the blob-read + tag-library helpers out of `image-ocr.ts` (which is deleted in cleanup) and adds the state machine.

- [ ] **Step 1: Create `server/services/image-enrich.ts`**

```ts
import { and, eq, isNull, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { useDb } from '../db'
import { documents, images } from '../db/schema'
import { storage } from '../utils/storage'
import { describeImageFull } from '../lib/ai/vision'
import { embed } from '../lib/ai/embeddings'
import { splitTags, buildTagLibrary } from './tag-library'
import { capTags } from '../../shared/utils/cap-tags'
import { cleanToMarkdown } from '../lib/ai/transcribe'
import { createDoc } from './documents'
import { slugify } from '../../shared/utils/slugify'

const OCR_MAX_SIZE = 10 * 1024 * 1024 // 10 MB
const ENRICHABLE_KINDS = ['image', 'gif']

/** Read an image blob from storage and return a base64 data: URL for the vision model. */
async function readImageDataUrl(storageKey: string, mime: string): Promise<string> {
  const { stream } = await storage().get(storageKey)
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`
}

async function markFailed(id: string, error: string): Promise<typeof images.$inferSelect | null> {
  const [r] = await useDb().update(images)
    .set({ enrichStatus: 'failed', enrichError: error.slice(0, 500), enrichAttempts: sql`${images.enrichAttempts} + 1` })
    .where(eq(images.id, id)).returning()
  return r ?? null
}

/**
 * Full enrichment pipeline for one image. Never throws. Enrich-first: existing
 * tags/summary are only overwritten on a real vision result.
 */
export async function enrichImage(id: string): Promise<typeof images.$inferSelect | null> {
  const db = useDb()
  const [img] = await db.select().from(images).where(and(eq(images.id, id), isNull(images.deletedAt))).limit(1)
  if (!img) return null

  // Non-enrichable kinds (video): mark done, no model call.
  if (!ENRICHABLE_KINDS.includes(img.kind)) {
    const [r] = await db.update(images).set({ enrichStatus: 'done', enrichError: null }).where(eq(images.id, id)).returning()
    return r ?? img
  }

  await db.update(images).set({ enrichStatus: 'processing', enrichError: null }).where(eq(images.id, id))

  if (img.size > OCR_MAX_SIZE) {
    const [r] = await db.update(images).set({ enrichStatus: 'done', ocrText: img.ocrText ?? '' }).where(eq(images.id, id)).returning()
    return r ?? img
  }

  let result
  try {
    const dataUrl = await readImageDataUrl(img.storageKey, img.mime)
    result = await describeImageFull(dataUrl)
  } catch (err) {
    return await markFailed(id, (err as Error).message)
  }

  // Empty result → preserve existing data, record the attempt as failed (retryable).
  if (!result.summary && !result.ocrText && result.tags.length === 0) {
    return await markFailed(id, 'vision returned empty result')
  }

  // Tag split: library matches auto-apply to tags, new → recommendedTags.
  const library = await buildTagLibrary()
  const { confirmed, recommended } = splitTags(result.tags, library)

  // Optional document spin-off from the OCR markdown.
  if (img.makeDocument && result.ocrText.trim()) {
    try {
      const { title, markdown } = await cleanToMarkdown(result.ocrText)
      const effectiveTitle = title || img.originalName || `Scanned ${img.createdAt.toISOString().slice(0, 10)}`
      // Reuse an existing linked doc if present, else create one.
      const [existingDoc] = await db.select({ id: documents.id }).from(documents)
        .where(and(eq(documents.ocrId, id), isNull(documents.deletedAt))).limit(1)
      if (existingDoc) {
        await db.update(documents).set({ content: markdown || '(no text recognized)', title: effectiveTitle })
          .where(eq(documents.id, existingDoc.id))
      } else {
        const doc = await createDoc({
          path: `/input/${slugify(effectiveTitle)}-${nanoid(8)}.md`,
          title: effectiveTitle,
          content: markdown || '(no text recognized)'
        })
        await db.update(documents).set({ ocrId: id }).where(eq(documents.id, doc.id))
      }
    } catch (err) {
      console.warn(`[image-enrich] doc spin-off failed for ${id}:`, err)
      // non-fatal — continue with image enrichment
    }
  }

  // Embed the summary.
  let embedding: number[] | null = null
  if (result.summary.trim()) {
    try { [embedding] = await embed([result.summary]) } catch (err) {
      return await markFailed(id, `embed failed: ${(err as Error).message}`)
    }
  }

  const [r] = await db.update(images).set({
    summary: result.summary || null,
    ocrText: result.ocrText || '',
    tags: capTags([...img.tags, ...confirmed], 50),
    recommendedTags: capTags(recommended, 10),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embedding: embedding as any,
    enrichStatus: 'done',
    enrichError: null
  }).where(eq(images.id, id)).returning()
  return r ?? img
}

/** Re-embed the image's CURRENT summary only (no vision call). For the Revectorize button. */
export async function revectorizeImage(id: string): Promise<typeof images.$inferSelect | null> {
  const db = useDb()
  const [img] = await db.select().from(images).where(and(eq(images.id, id), isNull(images.deletedAt))).limit(1)
  if (!img) return null
  if (!img.summary?.trim()) {
    const [r] = await db.update(images).set({ embedding: null }).where(eq(images.id, id)).returning()
    return r ?? img
  }
  try {
    const [vec] = await embed([img.summary])
    const [r] = await db.update(images)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ embedding: vec as any }).where(eq(images.id, id)).returning()
    return r ?? img
  } catch (err) {
    return await markFailed(id, `revectorize failed: ${(err as Error).message}`)
  }
}
```

- [ ] **Step 2: Extract the tag-library helper** — Create `server/services/tag-library.ts`

`buildTagLibrary` and `splitTags` currently live in `image-ocr.ts` (which we delete). Move them into a shared module so both `image-enrich.ts` and anything else can import them. Read the current implementations in `server/services/image-ocr.ts` (the `splitTags` export and the private `buildTagLibrary`) and move them verbatim into `server/services/tag-library.ts`, exporting both. Then in `image-ocr.ts`, replace its local definitions with `import { splitTags, buildTagLibrary } from './tag-library'` (re-export `splitTags` if other code imports it from image-ocr — check `grep -rn "from.*image-ocr" server test`). Keep `tag-split.test.ts` green (update its import path if it imports from image-ocr).

- [ ] **Step 3: Verify** — `pnpm typecheck && pnpm test && pnpm build`. Expected PASS (207 tests green; tag-split test still passes from the new path).

- [ ] **Step 4: Commit**
```bash
git add server/services/image-enrich.ts server/services/tag-library.ts server/services/image-ocr.ts test/
git commit --no-verify -m "feat(images): enrichImage pipeline worker + revectorize + shared tag-library"
```

---

### Task 4: Cron worker swap

**Files:** Create `server/tasks/enrich-images.ts`; Modify `nuxt.config.ts`, `server/api/admin/ocr-run.post.ts`.

- [ ] **Step 1: Create `server/tasks/enrich-images.ts`**

```ts
import { and, isNull, lt, or, eq, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { images } from '../db/schema'
import { enrichImage } from '../services/image-enrich'

const MAX_ATTEMPTS = 3

export default defineTask({
  meta: { name: 'enrich-images', description: 'Run the image enrichment pipeline on pending/retryable images' },
  async run() {
    const db = useDb()
    const candidates = await db.select({ id: images.id }).from(images)
      .where(and(
        isNull(images.deletedAt),
        or(
          eq(images.enrichStatus, 'pending'),
          and(eq(images.enrichStatus, 'failed'), lt(images.enrichAttempts, MAX_ATTEMPTS))
        )
      ))
      .limit(20)
    let done = 0, failed = 0
    for (const c of candidates) {
      const r = await enrichImage(c.id)
      if (r?.enrichStatus === 'done') done++; else failed++
    }
    const [{ remaining }] = await db.select({ remaining: sql<number>`count(*)::int` }).from(images)
      .where(and(isNull(images.deletedAt), or(eq(images.enrichStatus, 'pending'), and(eq(images.enrichStatus, 'failed'), lt(images.enrichAttempts, MAX_ATTEMPTS)))))
    return { result: { done, failed, remaining } }
  }
})
```

- [ ] **Step 2: Update `nuxt.config.ts` cron** — change `'*/7 * * * *': ['ocr-images']` to `'*/7 * * * *': ['enrich-images']`.

- [ ] **Step 3: Update the admin trigger** — `server/api/admin/ocr-run.post.ts`: replace its body with `import { enrichImage } from '../../services/image-enrich'` driving a batch, OR simplest: call the same candidate logic. Replace the handler with one that runs the enrich-images task logic for a batch:
```ts
import { and, isNull, lt, or, eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { images } from '../../db/schema'
import { enrichImage } from '../../services/image-enrich'

export default defineEventHandler(async () => {
  const db = useDb()
  const rows = await db.select({ id: images.id }).from(images)
    .where(and(isNull(images.deletedAt), or(eq(images.enrichStatus, 'pending'), and(eq(images.enrichStatus, 'failed'), lt(images.enrichAttempts, 3)))))
    .limit(20)
  let done = 0, failed = 0
  for (const r of rows) { const x = await enrichImage(r.id); if (x?.enrichStatus === 'done') done++; else failed++ }
  return { done, failed }
})
```

- [ ] **Step 4: Verify + commit** — `pnpm typecheck && pnpm build`.
```bash
git add server/tasks/enrich-images.ts nuxt.config.ts server/api/admin/ocr-run.post.ts
git commit --no-verify -m "feat(images): status-driven enrich-images cron (replaces ocr-images)"
```

---

### Task 5: Upload async + `makeDocument`

**Files:** Modify `server/services/images.ts` (`createImage`), `server/api/upload.post.ts`.

- [ ] **Step 1: `createImage` accepts `makeDocument`** — In `server/services/images.ts`, add an options param. Read the current `createImage(buffer, mime, originalName?)`; extend to `createImage(buffer, mime, originalName?, opts?: { makeDocument?: boolean })` and set `makeDocument: opts?.makeDocument ?? false` in the insert values. The row already defaults `enrichStatus='pending'` via the schema, so the cron picks it up — upload stays effectively async (no synchronous enrich, as today).

- [ ] **Step 2: `upload.post.ts` reads the flag** — Read the file. It currently reads the multipart file + optional `public` query. Add reading a `makeDocument` flag (query `?makeDocument=1` or a form field) and pass it: `createImage(buf, mime, name, { makeDocument })`. Keep the immediate return of the created image DTO.

- [ ] **Step 3: Verify + commit** — `pnpm typecheck && pnpm build`.
```bash
git add server/services/images.ts server/api/upload.post.ts
git commit --no-verify -m "feat(images): upload accepts makeDocument; row enters pending pipeline"
```

---

### Task 6: Reprocess / Revectorize / PATCH endpoints

**Files:** Create `server/api/images/[id]/reprocess.post.ts`, `server/api/images/[id]/revectorize.post.ts`; Delete `server/api/images/[id]/rescan.post.ts`; Modify `server/api/images/[id]/index.patch.ts`, `server/services/images.ts`.

- [ ] **Step 1: `reprocess.post.ts`**
```ts
import { enrichImage } from '../../../services/image-enrich'
import { serveUrl } from '../../../services/images'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const row = await enrichImage(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return { ...row, url: serveUrl(row) }
})
```

- [ ] **Step 2: `revectorize.post.ts`**
```ts
import { revectorizeImage } from '../../../services/image-enrich'
import { serveUrl } from '../../../services/images'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const row = await revectorizeImage(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return { ...row, url: serveUrl(row) }
})
```

- [ ] **Step 3: Delete `server/api/images/[id]/rescan.post.ts`** (`git rm`).

- [ ] **Step 4: Extend PATCH** — In `server/services/images.ts`, add a `patchImage(id, patch)` that updates any of `summary`, `ocrText`, `tags`, `recommendedTags`, `isPublic` (reuse/extend the existing `patchTags`/`setImagePublic` or add one function). Then update `server/api/images/[id]/index.patch.ts`'s Zod `Body` to also accept `summary: z.string().nullable().optional()`, `ocrText: z.string().nullable().optional()` and route them through the service. Keep returning `{ ...row, url: serveUrl(row) }`.

- [ ] **Step 5: Verify + commit** — `pnpm typecheck && pnpm build`.
```bash
git add server/api/images/ server/services/images.ts
git rm server/api/images/\[id\]/rescan.post.ts
git commit --no-verify -m "feat(images): reprocess + revectorize endpoints; PATCH summary/ocr/tags"
```

---

### Task 7: Hybrid image search

**Files:** Modify `server/services/images.ts` (add `searchImages`), `server/services/search.ts`.

- [ ] **Step 1: Add `searchImages(q)` to `server/services/images.ts`** (mirror `searchDocs` in documents.ts):

```ts
import { embedOne } from '../lib/ai/embeddings'
import { rrfFuse } from '../lib/ai/rrf'
// ... existing imports (and, or, ilike, isNull, sql, inArray, useDb, images, serveUrl)

export async function searchImages(q: string): Promise<(Image & { url: string })[]> {
  if (!q.trim()) return []
  const db = useDb()
  const pattern = `%${q}%`

  // Lane 1: lexical — ocr/summary ILIKE + tag overlap, similarity-ordered
  const lexRows = await db.select({ id: images.id }).from(images)
    .where(and(live(), or(
      ilike(images.ocrText, pattern),
      ilike(images.summary, pattern),
      sql`${images.tags} && ARRAY[${q}]::text[]`,
      sql`${images.recommendedTags} && ARRAY[${q}]::text[]`
    )))
    .orderBy(sql`similarity(coalesce(${images.summary},'') || ' ' || coalesce(${images.ocrText},''), ${q}) desc`)
    .limit(50)
  const lexIds = lexRows.map(r => r.id)

  // Lane 2: vector — cosine distance over the summary embedding
  let vecIds: string[] = []
  try {
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const vecRows = await db.select({ id: images.id }).from(images)
      .where(and(live(), sql`${images.embedding} is not null`))
      .orderBy(sql`${images.embedding} <=> ${lit}::halfvec`)
      .limit(50)
    vecIds = vecRows.map(r => r.id)
  } catch (err) {
    console.warn('[searchImages] vector lane failed, lexical-only:', err)
  }

  const fused = rrfFuse([lexIds, vecIds]).slice(0, 50)
  if (!fused.length) return []
  const fetched = await db.select().from(images).where(and(live(), inArray(images.id, fused)))
  const byId = new Map(fetched.map(r => [r.id, r]))
  return fused.flatMap(id => { const r = byId.get(id); return r ? [{ ...r, url: serveUrl(r) }] : [] })
}
```
(`live()` is the existing `() => isNull(images.deletedAt)` helper in images.ts; add `inArray`/`ilike` to the drizzle import if missing.)

- [ ] **Step 2: Swap the search.ts images lane** — In `server/services/search.ts`, replace the images lane's inline query with `searchImages(q)`:
```ts
    // Lane: images — hybrid (lexical + summary vector, RRF)
    (async () => {
      try {
        const rows = await searchImages(q)
        return rows.slice(0, perGroup).map(r => ({ type: 'image' as const, id: r.id, url: r.url, tags: r.tags, to: '/gallery' }))
      } catch { return [] }
    })(),
```
Add `import { serveUrl, searchImages } from './images'` (drop the now-unused direct `images` import if nothing else uses it).

- [ ] **Step 3: Verify + commit** — `pnpm typecheck && pnpm build`.
```bash
git add server/services/images.ts server/services/search.ts
git commit --no-verify -m "feat(search): hybrid image search (summary vector + lexical RRF)"
```

---

### Task 8: Capture UI — drop Transcribe, add toggle

**Files:** Modify `app/pages/capture.vue`, `app/composables/useImages.ts`.

- [ ] **Step 1: `useImages.upload` accepts `makeDocument`** — In `app/composables/useImages.ts`, change `upload(file, isPublic=false)` to `upload(file, isPublic=false, makeDocument=false)` and append `&makeDocument=1` to the query when true (mirror the `?public=1` pattern). Return type unchanged.

- [ ] **Step 2: Rework `capture.vue`** — Read the file. Remove the `Transcribe` tab from the `tabs` array (leave `Note`, `Image`) and delete the transcribe `#transcribe` template + its handlers (the two-step upload + `/api/capture/transcribe` call). In the `Image` mode template, add a `USwitch` labeled **"Also save as document"** bound to a new `const makeDoc = ref(false)`, and pass it: `images.upload(file, imagePublic.value, makeDoc.value)`. Semantic tokens only.

- [ ] **Step 3: Verify** — `pnpm typecheck && pnpm build`. (Live E2E later.)

- [ ] **Step 4: Commit**
```bash
git add app/pages/capture.vue app/composables/useImages.ts
git commit --no-verify -m "feat(capture): Note/Image only; 'Also save as document' toggle"
```

---

### Task 9: Gallery modal — editable metadata + buttons

**Files:** Modify `app/pages/gallery.vue`, `app/composables/useImages.ts`.

- [ ] **Step 1: Composable methods** — In `useImages.ts` add:
```ts
  const reprocess = (id: string) => ofetch<ImageDTO>(`/api/images/${id}/reprocess`, { method: 'POST' })
  const revectorize = (id: string) => ofetch<ImageDTO>(`/api/images/${id}/revectorize`, { method: 'POST' })
  const updateMeta = (id: string, body: { summary?: string | null, ocrText?: string | null, tags?: string[], recommendedTags?: string[] }) =>
    patch(id, body)
  const addTag = (img: ImageDTO, tag: string) =>
    patch(img.id, { tags: [...img.tags, tag], recommendedTags: img.recommendedTags.filter(t => t !== tag) })
```
Add all to the returned object (alongside the existing `rescan` → rename to remove `rescan`, since the endpoint is gone; replace its usages).

- [ ] **Step 2: Gallery modal edits** — In `app/pages/gallery.vue`:
  - Replace the read-only OCR block with an editable `UTextarea` bound to `selected.ocrText`, saved on blur via `withMutate(() => images.updateMeta(selected.value!.id, { ocrText: selected.value!.ocrText }))`.
  - Add a **Summary** `UTextarea` (same edit-on-blur → `updateMeta({ summary })`).
  - Add a custom-tag `UInput` + Add button → `withMutate(() => images.addTag(selected.value!, newTag))`; keep approve/dismiss/remove.
  - Add a status `UBadge` from `selected.enrichStatus` (color: `processing`→info, `failed`→error, `done`→success) and show `selected.enrichError` when failed.
  - Footer: replace the Rescan button with **Reprocess** (`@click` → `withMutate(() => images.reprocess(selected.value!.id))`) and add **Revectorize** (`withMutate(() => images.revectorize(...))`), keeping Delete left / Close right (Reprocess+Revectorize+Close grouped right). `:loading="mutating"`.
  - Update any `images.rescan` reference to `images.reprocess`.

- [ ] **Step 3: Verify** — `pnpm typecheck && pnpm build`.

- [ ] **Step 4: Commit**
```bash
git add app/pages/gallery.vue app/composables/useImages.ts
git commit --no-verify -m "feat(gallery): editable summary/ocr/tags, status badge, Reprocess/Revectorize"
```

---

### Task 10: Doc → source image link

**Files:** Modify `shared/types` doc DTO + the document view page.

- [ ] **Step 1: Expose `ocrId` on the document DTO** — Find the document DTO/`toDTO` in `server/services/documents.ts`; add `ocrId: row.ocrId` to the mapped DTO and the `DocumentDTO` type (`shared/types/documents.ts` or wherever it lives). 

- [ ] **Step 2: Doc view link** — In the document view (`app/pages/documents.vue` or the doc detail component — grep for where a `DocumentDTO` is rendered with its title/toolbar), add, when `doc.ocrId` is set, a small link/button "View source image" → `/gallery?image=${doc.ocrId}` (or open the gallery; match how gallery deep-links if it supports `?image=`; if not, just link to `/gallery`). Semantic tokens.

- [ ] **Step 3: Verify + commit** — `pnpm typecheck && pnpm build`.
```bash
git add shared/ server/services/documents.ts app/pages/documents.vue
git commit --no-verify -m "feat(documents): expose ocr_id + source-image link on transcribed docs"
```

---

### Task 11: Backfill admin endpoint

**Files:** Create `server/api/admin/images-backfill.post.ts`.

- [ ] **Step 1: Implement**
```ts
import { and, isNull, ne } from 'drizzle-orm'
import { useDb } from '../../db'
import { images } from '../../db/schema'

// Mark images for (re)enrichment. ?all=1 re-enriches everything; default only non-done.
export default defineEventHandler(async (event) => {
  const all = getQuery(event).all === '1'
  const where = all
    ? isNull(images.deletedAt)
    : and(isNull(images.deletedAt), ne(images.enrichStatus, 'done'))
  const updated = await useDb().update(images)
    .set({ enrichStatus: 'pending', enrichAttempts: 0, enrichError: null })
    .where(where).returning({ id: images.id })
  return { queued: updated.length }
})
```
(Global auth middleware covers `/api/admin/*`.)

- [ ] **Step 2: Verify + commit** — `pnpm typecheck && pnpm build`.
```bash
git add server/api/admin/images-backfill.post.ts
git commit --no-verify -m "feat(images): admin backfill endpoint (mark pending for re-enrich)"
```

---

### Task 12: Cleanup + DTO + E2E + docs

**Files:** Delete `server/services/image-ocr.ts`, `server/api/capture/transcribe.post.ts`; Modify `shared/types/images.ts`; docs.

- [ ] **Step 1: Update `ImageDTO`** — In `shared/types/images.ts`, add `summary: string | null`, `enrichStatus: string`, `enrichError: string | null`, `enrichAttempts: number`, `makeDocument: boolean`. (Endpoints already spread `...row`, so the fields flow through; `embedding` must NOT be in the DTO — confirm the spread doesn't leak it. The endpoints return `{ ...row, url }`; `row` includes `embedding`. **Add an explicit redaction**: in `serveUrl`-adjacent mapping or each endpoint, strip `embedding` before returning — simplest is a `toImageDTO(row)` helper in images.ts that omits `embedding`, and use it in all image endpoints. Implement `toImageDTO` and route all image responses through it.)

- [ ] **Step 2: Delete dead files** — `git rm server/services/image-ocr.ts server/api/capture/transcribe.post.ts`. Fix any remaining imports (grep `image-ocr`, `capture/transcribe`, `describeImage(` — the old `describeImage` may now be unused; if so remove it from vision.ts; if still referenced, leave it). Run `pnpm typecheck` and resolve breakages.

- [ ] **Step 3: Full gate** — `pnpm typecheck && pnpm test && pnpm build && pnpm db:migrate`. All PASS; 207+ tests green.

- [ ] **Step 4: Live E2E (`playwright-cli`)** — with `pnpm dev` + logged in (note: the vision rig `:8005` must be reachable for enrichment to produce results; if down, verify the pipeline mechanics — status transitions, editing, search wiring — and document vision-dependent steps as pending):
  1. Capture an image (toggle OFF) → it appears in gallery `enrich_status` pending → after the worker runs (or click Reprocess) → summary + tags appear.
  2. Capture an image with the "Also save as document" toggle ON → a `/documents` row is created with the OCR text and links back to the image.
  3. Gallery modal: edit the summary, click **Revectorize**; edit OCR; add a custom tag; approve/dismiss suggestions — all persist across reload.
  4. Global search: a semantic query returns an image by summary (not just exact token).
  5. `POST /api/admin/images-backfill` marks images pending; the worker reprocesses.
  Capture a screenshot.

- [ ] **Step 5: Docs** — update `docs/wiki/image-hosting.md` (the new pipeline: states, unified vision pass, summary embedding, hybrid search, editable metadata, Reprocess/Revectorize, backfill); note capture is Note/Image with the document toggle. Add a handover `docs/handovers/2026-06-11-image-pipeline.md` (frontmatter matching house style: title/cycle/date/status: shipped/shipped list/verified/deferred/known_considerations). Add a roadmap entry (new cycle). Set the spec frontmatter `status: shipped`.

- [ ] **Step 6: Commit**
```bash
git add -A && git commit --no-verify -m "refactor(images): remove legacy ocr/transcribe; ImageDTO + redaction; docs"
```

---

## Self-Review Notes

- **Spec coverage:** schema (Task 1) · unified vision (Task 2) · `enrichImage`/`revectorize` state machine + tag-split + doc spin-off + embed (Task 3) · cron (Task 4) · async capture + makeDocument (Tasks 5, 8) · reprocess/revectorize/PATCH (Task 6) · hybrid image search (Task 7) · editable gallery (Task 9) · doc→image link (Task 10) · backfill (Task 11) · cleanup + DTO redaction + E2E + docs (Task 12). All spec sections map to a task.
- **Type consistency:** `enrichImage`/`revectorizeImage` return `images.$inferSelect | null`; endpoints map via `toImageDTO`(+url). `describeImageFull`/`parseVisionResponse` return `VisionFull {summary,ocrText,tags}`. `splitTags`/`buildTagLibrary` live in `tag-library.ts`. Column field names: `enrichStatus`/`enrichError`/`enrichAttempts`/`makeDocument`/`summary`/`embedding` (images), `ocrId` (documents) — used identically across tasks.
- **Build-green sequencing:** Task 1 renames `ocrAttempts`→`enrichAttempts` AND patches `image-ocr.ts` references so it keeps compiling until deleted in Task 12; `image-ocr.ts`'s helpers move to `tag-library.ts` in Task 3 (image-ocr re-imports them) so nothing breaks before its Task 12 deletion.
- **Security/redaction:** `embedding` (halfvec) must never serialize to the client — Task 12 adds `toImageDTO` redaction; verify no image endpoint returns a raw `...row` with `embedding`. (Cross-check the reprocess/revectorize/patch endpoints from Tasks 6 — they return `{...row, url}`; update them to `toImageDTO` in Task 12.)
- **Known judgment calls:** enrich-first (failure preserves tags/summary); doc spin-off failure is non-fatal to image enrichment; `tags` merge caps at 50 to avoid unbounded growth on repeated reprocess; backfill default excludes `done`.
- **No DB-backed endpoint tests** (harness is pure-logic) — `parseVisionResponse` + `splitTags` are unit-tested; the rest via typecheck/build/E2E.
