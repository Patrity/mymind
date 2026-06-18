# Document Chunking + Contextual Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace whole-document embedding with a shared chunking primitive + LLM contextual retrieval so large markdown docs (and long image OCR) are chunked, contextualized, embedded, and retrievable.

**Architecture:** A pure markdown chunker produces ~300-token structure-aware chunks; a resilient `bulk`-model step prepends a chunk-specific context sentence before embedding; chunks live in one generic `chunks` table (`source_type`/`source_id`/`ord`) with an HNSW index; `searchDocs` collapses chunk hits to docs while a new `searchPassages` returns chunk-level passages.

**Tech Stack:** Nuxt 4 / Nitro, Drizzle ORM + Postgres + pgvector (`halfvec(2560)`), TEI embeddings, vitest, zod, MCP SDK.

**Branch:** `feat/document-chunking` (already created off `master`). Spec: `docs/superpowers/specs/2026-06-17-document-chunking-contextual-retrieval-design.md`.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `server/lib/chunking/chunk-markdown.ts` | Pure markdown → `Chunk[]` (structure-aware + recursive fallback) | Create |
| `server/lib/chunking/config.ts` | Chunking sizes + `contextual` flag (settings-backed, defaults) | Create |
| `server/lib/chunking/contextualize.ts` | Chunk → situating sentence (resilient, flag-gated) | Create |
| `server/lib/chunking/embed-source.ts` | `chunkAndEmbedSource()` — chunk → contextualize → embed → upsert rows | Create |
| `server/lib/chunking/collapse.ts` | Pure `collapseChunksToSources()` (best-per-source) | Create |
| `server/db/schema/chunks.ts` | `chunks` table | Create |
| `server/db/schema/documents.ts` | add `chunkedHash` | Modify |
| `server/db/schema/index.ts` | export `chunks` | Modify |
| `server/db/migrations/00XX_*.sql` | chunks table + `documents.chunked_hash` + HNSW index | Create (generate + edit) |
| `server/services/embedding.ts` | rewrite `runEmbedding` to chunk-embed docs | Modify |
| `server/services/documents.ts` | `searchDocs` vector lane → chunks; add `searchPassages` | Modify |
| `server/services/image-enrich.ts` | chunk long OCR via the primitive | Modify |
| `server/lib/agent/tools.ts` | add `search_passages` MCP/agent tool | Modify |
| `shared/types/documents.ts` | add `ChunkHit` type | Modify |
| `test/chunk-markdown.test.ts` | chunker unit tests | Create |
| `test/contextualize.test.ts` | contextualize unit tests (mocked model) | Create |
| `test/chunk-collapse.test.ts` | collapse unit tests | Create |

Gates (memory): `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm db:migrate`. Lint is NOT a gate. Commit per task; do NOT push `master`.

---

### Task 1: Spike — confirm rig limits (no code gate)

**Goal:** De-risk §4 of the spec before backfill. Record findings in the eventual handover.

- [ ] **Step 1: Find TEI max input/batch + the `bulk` model**

Run (read-only): inspect the embeddings + bulk model config.
```bash
grep -rn "bulk\|embeddings" server/lib/ai/registry/ | head -30
```
Then in the running app, hit the rig's TEI `/info` (the `baseURL` from the embeddings usage) to read `max_input_length` and `max_client_batch_size`.

- [ ] **Step 2: Check prefix caching**

Determine whether the `bulk` chat server (vLLM/SGLang) does automatic prefix caching. If unknown, send two identical large-prefix completions back-to-back and compare latency (second should be faster if cached).

- [ ] **Step 3: Record findings**

Write a short note (TEI `max_client_batch_size` → sets `EMBED_BATCH`; prefix caching yes/no → affects backfill speed) to paste into the handover. **No commit** (investigation only). If caching is absent AND per-chunk latency is high, plan to run the first backfill with `contextual` off (breadcrumb fallback), then enable contextual incrementally.

---

### Task 2: `chunks` table + `documents.chunked_hash` + migration

**Files:**
- Create: `server/db/schema/chunks.ts`
- Modify: `server/db/schema/documents.ts:18-19` (add `chunkedHash`)
- Modify: `server/db/schema/index.ts` (add export)
- Create: `server/db/migrations/00XX_*.sql` (via generate + hand-edit)

- [ ] **Step 1: Create the schema file**

`server/db/schema/chunks.ts`:
```typescript
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { halfvec } from '../types/halfvec'

export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sourceType: text('source_type').notNull(),       // 'document' | 'image'
  sourceId: uuid('source_id').notNull(),
  ord: integer('ord').notNull(),
  content: text('content').notNull(),              // raw chunk text — the returned passage
  context: text('context'),                        // LLM situating sentence (nullable)
  headingPath: text('heading_path'),               // 'Title › H1 › H2' breadcrumb
  tokenCount: integer('token_count'),
  charStart: integer('char_start'),
  charEnd: integer('char_end'),
  embedding: halfvec(2560),
  embeddedTextHash: text('embedded_text_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  sourceOrdUnique: uniqueIndex('chunks_source_ord_uidx').on(t.sourceType, t.sourceId, t.ord),
  sourceIdx: index('chunks_source_idx').on(t.sourceType, t.sourceId)
  // HNSW index on embedding is added by hand in the migration (opclass not expressible in drizzle).
}))

export type Chunk = typeof chunks.$inferSelect
export type NewChunk = typeof chunks.$inferInsert
```

- [ ] **Step 2: Add `chunkedHash` to documents schema**

In `server/db/schema/documents.ts`, after line 19 (`embeddedHash: text('embedded_hash'),`) add:
```typescript
  chunkedHash: text('chunked_hash'),
```

- [ ] **Step 3: Wire the barrel export**

In `server/db/schema/index.ts` add (alphabetical-ish, alongside the others):
```typescript
export * from './chunks'
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `server/db/migrations/00XX_*.sql` creating table `chunks`, the unique + btree indexes, the `halfvec(2560)` column, and `ALTER TABLE "documents" ADD COLUMN "chunked_hash" text`. Confirm `meta/_journal.json` updated.

- [ ] **Step 5: Hand-add the HNSW index**

Append to the generated `00XX_*.sql` (matches `0017_solid_stingray.sql:19` style):
```sql
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw ON chunks USING hnsw (embedding halfvec_cosine_ops);
```

- [ ] **Step 6: Apply + verify**

Run: `pnpm db:migrate`
Expected: applies cleanly. Then `pnpm typecheck` (expected: PASS — new types resolve).

- [ ] **Step 7: Commit**
```bash
git add server/db/schema/chunks.ts server/db/schema/documents.ts server/db/schema/index.ts server/db/migrations/
git commit -m "feat(chunks): chunks table + documents.chunked_hash + HNSW index"
```

---

### Task 3: Pure markdown chunker (TDD)

**Files:**
- Create: `server/lib/chunking/chunk-markdown.ts`
- Test: `test/chunk-markdown.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/chunk-markdown.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { chunkMarkdown, estimateTokens } from '../server/lib/chunking/chunk-markdown'

const long = (word: string, tokens: number) => Array(Math.ceil(tokens)).fill(word).join(' ')

describe('chunkMarkdown', () => {
  it('returns a single chunk for a short doc, breadcrumb = title', () => {
    const out = chunkMarkdown('Hello world.\n\nSecond paragraph.', { title: 'My Doc' })
    expect(out).toHaveLength(1)
    expect(out[0]!.ord).toBe(0)
    expect(out[0]!.headingPath).toBe('My Doc')
    expect(out[0]!.content).toContain('Hello world.')
  })

  it('splits by heading hierarchy with breadcrumbs', () => {
    const md = '# Intro\n\nalpha text.\n\n## Details\n\nbeta text.'
    const out = chunkMarkdown(md, { title: 'Guide' })
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out.some(c => c.headingPath === 'Guide › Intro' && c.content.includes('alpha'))).toBe(true)
    expect(out.some(c => c.headingPath === 'Guide › Intro › Details' && c.content.includes('beta'))).toBe(true)
  })

  it('recursively splits an oversized section under the cap, ords are sequential', () => {
    const md = '# Big\n\n' + long('lorem', 1500)
    const out = chunkMarkdown(md, { title: 'T', targetTokens: 300, maxTokens: 512 })
    expect(out.length).toBeGreaterThan(2)
    for (const c of out) expect(c.tokenCount).toBeLessThanOrEqual(512)
    expect(out.map(c => c.ord)).toEqual(out.map((_, i) => i))
  })

  it('keeps a fenced code block atomic (does not split on its blank lines)', () => {
    const md = '# Code\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter.'
    const out = chunkMarkdown(md, { title: 'T' })
    const codeChunk = out.find(c => c.content.includes('const a = 1;'))
    expect(codeChunk!.content).toContain('const b = 2;') // same chunk, not split at the blank line
  })

  it('does not treat a heading-like line inside a code fence as a heading', () => {
    const md = '# Real\n\n```\n# not a heading\nbody\n```\n'
    const out = chunkMarkdown(md, { title: 'T' })
    expect(out.every(c => c.headingPath === 'T › Real')).toBe(true)
  })

  it('charStart/charEnd map back into the source', () => {
    const src = '# H\n\nhello body here.'
    const out = chunkMarkdown(src, { title: 'T' })
    const c = out[0]!
    expect(src.slice(c.charStart, c.charEnd)).toContain('hello body here.')
  })

  it('estimateTokens is monotonic and positive', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBeGreaterThan(0)
    expect(estimateTokens('a'.repeat(380))).toBeGreaterThan(estimateTokens('a'.repeat(38)))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/chunk-markdown.test.ts`
Expected: FAIL ("chunkMarkdown is not a function").

- [ ] **Step 3: Implement the chunker**

`server/lib/chunking/chunk-markdown.ts`:
```typescript
export interface Chunk {
  ord: number
  content: string
  headingPath: string
  charStart: number
  charEnd: number
  tokenCount: number
}

export interface ChunkOptions {
  title?: string | null
  targetTokens?: number   // soft flush target
  maxTokens?: number      // hard cap per chunk
  overlapTokens?: number  // overlap on recursive sub-splits only
}

const CHARS_PER_TOKEN = 3.8
export const estimateTokens = (s: string): number =>
  s.length === 0 ? 0 : Math.ceil(s.length / CHARS_PER_TOKEN)

interface Section { headingPath: string; text: string; charStart: number }

/** Split into sections by markdown headings, fence-aware (headings inside ``` are ignored). */
function splitSections(text: string, title: string): Section[] {
  const lines = text.split('\n')
  const sections: Section[] = []
  const stack: string[] = [] // heading texts by depth (index = level-1)
  let buf: string[] = []
  let bufStart = 0
  let pos = 0
  let inFence = false

  const breadcrumb = () => [title, ...stack.filter(Boolean)].filter(Boolean).join(' › ')
  const flush = (start: number) => {
    const body = buf.join('\n').trim()
    if (body) sections.push({ headingPath: breadcrumb(), text: body, charStart: start })
    buf = []
  }

  for (const line of lines) {
    const fence = /^\s*```/.test(line)
    const heading = !inFence && /^(#{1,6})\s+(.*)$/.exec(line)
    if (fence) inFence = !inFence
    if (heading) {
      flush(bufStart)
      const level = heading[1]!.length
      stack.length = level - 1
      stack[level - 1] = heading[2]!.trim()
      bufStart = pos + line.length + 1
    } else {
      if (buf.length === 0) bufStart = pos
      buf.push(line)
    }
    pos += line.length + 1
  }
  flush(bufStart)
  return sections.length ? sections : [{ headingPath: title, text: text.trim(), charStart: 0 }]
}

/** Segment a section into atomic blocks: paragraphs, but fenced code / tables stay whole. */
function segmentBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let cur: string[] = []
  let inFence = false
  const push = () => { const b = cur.join('\n').trim(); if (b) blocks.push(b); cur = [] }
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const isTable = /^\s*\|.*\|\s*$/.test(line)
    if (!inFence && !isTable && line.trim() === '') { push(); continue }
    cur.push(line)
  }
  push()
  return blocks
}

/** Hard-split a single oversized block by line → sentence → word, ≤ max, with overlap. */
function hardSplit(block: string, max: number, overlap: number): string[] {
  if (estimateTokens(block) <= max) return [block]
  const maxChars = Math.floor(max * CHARS_PER_TOKEN)
  const overlapChars = Math.floor(overlap * CHARS_PER_TOKEN)
  // Prefer splitting on line, then sentence, then space, then hard char boundary.
  const units = block.split(/(?<=\n)|(?<=[.!?]\s)/)
  const out: string[] = []
  let cur = ''
  for (const u of units) {
    if (cur && (cur.length + u.length) > maxChars) {
      out.push(cur.trim())
      cur = overlapChars > 0 ? cur.slice(-overlapChars) : ''
    }
    cur += u
    while (cur.length > maxChars) { out.push(cur.slice(0, maxChars)); cur = cur.slice(maxChars - overlapChars) }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

export function chunkMarkdown(text: string, opts: ChunkOptions = {}): Chunk[] {
  const title = (opts.title ?? '').trim()
  const target = opts.targetTokens ?? 300
  const max = opts.maxTokens ?? 512
  const overlap = opts.overlapTokens ?? 32

  const sections = splitSections(text, title)
  const chunks: Chunk[] = []
  let ord = 0

  for (const sec of sections) {
    // pieces of text to emit for this section, with their offset within sec.text
    const pieces: string[] = []
    if (estimateTokens(sec.text) <= max) {
      pieces.push(sec.text)
    } else {
      const blocks = segmentBlocks(sec.text)
      let cur = ''
      for (const block of blocks) {
        const parts = hardSplit(block, max, overlap)
        for (const part of parts) {
          if (cur && estimateTokens(cur + '\n\n' + part) > target) { pieces.push(cur); cur = '' }
          cur = cur ? cur + '\n\n' + part : part
        }
      }
      if (cur.trim()) pieces.push(cur)
    }
    for (const piece of pieces) {
      const rel = sec.text.indexOf(piece.slice(0, 24))
      const charStart = sec.charStart + (rel >= 0 ? rel : 0)
      chunks.push({
        ord: ord++,
        content: piece,
        headingPath: sec.headingPath || title,
        charStart,
        charEnd: charStart + piece.length,
        tokenCount: estimateTokens(piece)
      })
    }
  }
  return chunks
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run test/chunk-markdown.test.ts`
Expected: PASS (all cases). If a recursive case exceeds `max`, tighten `hardSplit` until green.

- [ ] **Step 5: Commit**
```bash
git add server/lib/chunking/chunk-markdown.ts test/chunk-markdown.test.ts
git commit -m "feat(chunking): pure structure-aware markdown chunker"
```

---

### Task 4: Chunking config (settings-backed flag)

**Files:**
- Create: `server/lib/chunking/config.ts`

- [ ] **Step 1: Implement config reader**

`server/lib/chunking/config.ts` (mirrors the `loadConfig()` settings pattern at `server/lib/ai/registry/store.ts:13-19`):
```typescript
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'

export interface ChunkingConfig {
  contextual: boolean   // run the LLM contextualization step
  targetTokens: number
  maxTokens: number
  overlapTokens: number
  embedBatch: number    // ≤ TEI max_client_batch_size (set from Task 1)
}

const DEFAULTS: ChunkingConfig = { contextual: true, targetTokens: 300, maxTokens: 512, overlapTokens: 32, embedBatch: 32 }
const KEY = 'chunking'

export async function getChunkingConfig(): Promise<ChunkingConfig> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  const v = (row?.value ?? {}) as Partial<ChunkingConfig>
  return { ...DEFAULTS, ...v }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**
```bash
git add server/lib/chunking/config.ts
git commit -m "feat(chunking): settings-backed chunking config + contextual flag"
```

---

### Task 5: Contextualize step (TDD, mocked model)

**Files:**
- Create: `server/lib/chunking/contextualize.ts`
- Test: `test/contextualize.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/contextualize.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const chatMock = vi.fn()
vi.mock('../server/lib/ai/chat', () => ({ chat: (...a: unknown[]) => chatMock(...a) }))

import { contextualizeChunk } from '../server/lib/chunking/contextualize'

beforeEach(() => chatMock.mockReset())

describe('contextualizeChunk', () => {
  it('returns the LLM context when enabled and the call succeeds', async () => {
    chatMock.mockResolvedValue('This snippet covers DB setup.')
    const ctx = await contextualizeChunk({ doc: 'full doc', chunk: 'the chunk', headingPath: 'T › H', enabled: true })
    expect(ctx).toBe('This snippet covers DB setup.')
    expect(chatMock).toHaveBeenCalledOnce()
  })

  it('falls back to headingPath when the model throws', async () => {
    chatMock.mockRejectedValue(new Error('rig down'))
    const ctx = await contextualizeChunk({ doc: 'd', chunk: 'c', headingPath: 'T › H', enabled: true })
    expect(ctx).toBe('T › H')
  })

  it('skips the model entirely (returns headingPath) when disabled', async () => {
    const ctx = await contextualizeChunk({ doc: 'd', chunk: 'c', headingPath: 'T › H', enabled: false })
    expect(ctx).toBe('T › H')
    expect(chatMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/contextualize.test.ts`
Expected: FAIL ("contextualizeChunk is not a function").

- [ ] **Step 3: Implement**

`server/lib/chunking/contextualize.ts`:
```typescript
import { chat } from '../ai/chat'

const SYS = 'You situate a text chunk within its document for search retrieval. Reply with ONE short sentence (max ~25 words) describing what this chunk is about and where it sits in the document. No preamble.'

export async function contextualizeChunk(opts: {
  doc: string
  chunk: string
  headingPath: string
  enabled: boolean
}): Promise<string> {
  if (!opts.enabled) return opts.headingPath
  try {
    const user = `<document>\n${opts.doc}\n</document>\n\n<chunk>\n${opts.chunk}\n</chunk>\n\nGive the one-sentence context for the chunk.`
    const out = await chat('bulk', [
      { role: 'system', content: SYS },
      { role: 'user', content: user }
    ], { temperature: 0.1, maxTokens: 80 })
    const trimmed = out.trim()
    return trimmed || opts.headingPath
  } catch {
    return opts.headingPath  // resilient: never block embedding on a context failure
  }
}
```
> Note: pass the **whole `doc` as the stable first segment** so a prefix-caching server reuses it across the document's chunks (spec §4). If `chat`'s message type isn't structurally `{role,content}[]`, import `ChatMessage` from `../ai/chat` and type the array.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run test/contextualize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/lib/chunking/contextualize.ts test/contextualize.test.ts
git commit -m "feat(chunking): resilient flag-gated contextualization step"
```

---

### Task 6: `chunkAndEmbedSource` helper

**Files:**
- Create: `server/lib/chunking/embed-source.ts`

- [ ] **Step 1: Implement the shared helper**

`server/lib/chunking/embed-source.ts`:
```typescript
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { chunks } from '../../db/schema'
import { embed } from '../ai/embeddings'
import { chunkMarkdown } from './chunk-markdown'
import { contextualizeChunk } from './contextualize'
import { getChunkingConfig } from './config'

/**
 * Chunk a source's text, contextualize + embed each chunk, and replace the source's
 * chunk rows transactionally. Returns the number of chunks written.
 */
export async function chunkAndEmbedSource(opts: {
  sourceType: 'document' | 'image'
  sourceId: string
  title: string | null
  body: string
}): Promise<number> {
  const db = useDb()
  const cfg = await getChunkingConfig()
  const full = `${opts.title ?? ''}\n\n${opts.body}`.trim()
  const parts = chunkMarkdown(full, {
    title: opts.title, targetTokens: cfg.targetTokens, maxTokens: cfg.maxTokens, overlapTokens: cfg.overlapTokens
  })

  if (parts.length === 0) {
    await db.delete(chunks).where(and(eq(chunks.sourceType, opts.sourceType), eq(chunks.sourceId, opts.sourceId)))
    return 0
  }

  // Contextualize sequentially (keeps the doc prefix warm for prefix-caching servers).
  const contexts: string[] = []
  for (const p of parts) {
    contexts.push(await contextualizeChunk({ doc: full, chunk: p.content, headingPath: p.headingPath, enabled: cfg.contextual }))
  }

  // Embed prefixed texts in sub-batches.
  const embedTexts = parts.map((p, i) => `${contexts[i]}\n\n${p.content}`)
  const vectors: number[][] = []
  for (let i = 0; i < embedTexts.length; i += cfg.embedBatch) {
    const slice = embedTexts.slice(i, i + cfg.embedBatch)
    vectors.push(...await embed(slice))
  }

  const rows = parts.map((p, i) => ({
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    ord: p.ord,
    content: p.content,
    context: cfg.contextual ? contexts[i] : null,
    headingPath: p.headingPath,
    tokenCount: p.tokenCount,
    charStart: p.charStart,
    charEnd: p.charEnd,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embedding: vectors[i] as any,
    embeddedTextHash: createHash('sha256').update(embedTexts[i]!).digest('hex')
  }))

  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(and(eq(chunks.sourceType, opts.sourceType), eq(chunks.sourceId, opts.sourceId)))
    await tx.insert(chunks).values(rows)
  })
  return rows.length
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**
```bash
git add server/lib/chunking/embed-source.ts
git commit -m "feat(chunking): chunkAndEmbedSource (chunk → contextualize → embed → upsert)"
```

---

### Task 7: Rewrite `runEmbedding`

**Files:**
- Modify: `server/services/embedding.ts` (full rewrite)

- [ ] **Step 1: Rewrite the worker**

Replace the entire contents of `server/services/embedding.ts` with:
```typescript
import { and, isNull, or, sql, eq } from 'drizzle-orm'
import { useDb } from '../db'
import { documents } from '../db/schema'
import { chunkAndEmbedSource } from '../lib/chunking/embed-source'
import { publishChange } from '../utils/live-bus'

export async function runEmbedding({ limit = 200 } = {}): Promise<{ embedded: number, failed: number, remaining: number }> {
  const db = useDb()
  // docs needing (re)chunk: live, and chunked_hash != content_hash (null starts the backfill)
  const needWhere = and(
    isNull(documents.deletedAt),
    or(isNull(documents.chunkedHash), sql`${documents.chunkedHash} is distinct from ${documents.contentHash}`)
  )
  const rows = await db.select({ id: documents.id, title: documents.title, content: documents.content, contentHash: documents.contentHash })
    .from(documents).where(needWhere).limit(limit)

  let embedded = 0
  let failed = 0
  for (const r of rows) {
    try {
      await chunkAndEmbedSource({ sourceType: 'document', sourceId: r.id, title: r.title, body: r.content })
      await db.update(documents).set({ chunkedHash: r.contentHash }).where(eq(documents.id, r.id))
      publishChange({ resource: 'document', action: 'updated', id: r.id })
      embedded++
    } catch (err) {
      // leave chunked_hash stale → retried next run (chunks are ≤max tokens, so the 16k failure mode is gone)
      console.warn(`[embedding] failed to chunk/embed doc ${r.id}:`, (err as Error).message)
      failed++
    }
  }

  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(documents).where(needWhere)
  return { embedded, failed, remaining: Number(countRows[0]!.count) }
}
```
> The `embed-documents` task (`server/tasks/embed-documents.ts`) and `admin/embed-run` route call `runEmbedding` unchanged — no edits needed there. The `batch` param is gone (batching moved into `chunkAndEmbedSource`); confirm no caller passed `batch`.

- [ ] **Step 2: Typecheck + existing tests**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS. Fix any caller referencing the removed `batch` option.

- [ ] **Step 3: Commit**
```bash
git add server/services/embedding.ts
git commit -m "feat(embedding): runEmbedding chunks+contextualizes+embeds per doc"
```

---

### Task 8: Collapse helper (TDD)

**Files:**
- Create: `server/lib/chunking/collapse.ts`
- Test: `test/chunk-collapse.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/chunk-collapse.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { collapseChunksToSources } from '../server/lib/chunking/collapse'

describe('collapseChunksToSources', () => {
  it('keeps the best (first-seen, distance-ordered input) source id, deduped, order preserved', () => {
    // input is assumed pre-ordered by ascending distance (best first)
    const hits = [
      { sourceId: 'A', distance: 0.1 },
      { sourceId: 'B', distance: 0.2 },
      { sourceId: 'A', distance: 0.3 },
      { sourceId: 'C', distance: 0.4 }
    ]
    expect(collapseChunksToSources(hits)).toEqual(['A', 'B', 'C'])
  })

  it('handles empty input', () => {
    expect(collapseChunksToSources([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/chunk-collapse.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`server/lib/chunking/collapse.ts`:
```typescript
/** Collapse distance-ordered chunk hits to a deduped, order-preserved list of source ids. */
export function collapseChunksToSources(hits: { sourceId: string }[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const h of hits) {
    if (seen.has(h.sourceId)) continue
    seen.add(h.sourceId)
    out.push(h.sourceId)
  }
  return out
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run test/chunk-collapse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/lib/chunking/collapse.ts test/chunk-collapse.test.ts
git commit -m "feat(chunking): pure chunk→source collapse helper"
```

---

### Task 9: Chunk-aware search (`searchDocs` rewire + `searchPassages`)

**Files:**
- Modify: `shared/types/documents.ts` (add `ChunkHit`)
- Modify: `server/services/documents.ts:165-178` (vector lane) + add `searchPassages`

- [ ] **Step 1: Add the `ChunkHit` type**

Append to `shared/types/documents.ts`:
```typescript
export interface ChunkHit {
  sourceType: string
  sourceId: string
  ord: number
  content: string
  headingPath: string | null
  context: string | null
  docTitle: string | null
  docPath: string | null
  distance: number
}
```

- [ ] **Step 2: Rewire the `searchDocs` vector lane**

In `server/services/documents.ts`, add imports at the top:
```typescript
import { chunks } from '../db/schema'
import { collapseChunksToSources } from '../lib/chunking/collapse'
import type { ChunkHit } from '../../shared/types/documents'
```
Replace the vector-lane block (`documents.ts:166-178`, the `try { const qv = ... } catch {...}`) with:
```typescript
  let vectorIds: string[] = []
  try {
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const chunkRows = await db.select({ sourceId: chunks.sourceId })
      .from(chunks)
      .innerJoin(documents, eq(chunks.sourceId, documents.id))
      .where(and(eq(chunks.sourceType, 'document'), live(), projectFilter))
      .orderBy(sql`${chunks.embedding} <=> ${lit}::halfvec`)
      .limit(100)
    vectorIds = collapseChunksToSources(chunkRows).slice(0, 50)
  } catch (err) {
    console.warn('[searchDocs] vector lane failed, falling back to trigram-only:', err)
  }
```
> The rest of `searchDocs` (RRF fuse, hydrate) is unchanged — it still returns `DocumentDTO[]`.

- [ ] **Step 3: Add `searchPassages`**

Append to `server/services/documents.ts`:
```typescript
export async function searchPassages(q: string, opts: { project?: string, limit?: number, expand?: boolean } = {}): Promise<ChunkHit[]> {
  if (!q.trim()) return []
  const db = useDb()
  const projectFilter = opts.project ? eq(documents.project, opts.project) : undefined
  const qv = await embedOne(q)
  const lit = `[${qv.join(',')}]`
  const rows = await db.select({
    sourceType: chunks.sourceType, sourceId: chunks.sourceId, ord: chunks.ord,
    content: chunks.content, headingPath: chunks.headingPath, context: chunks.context,
    docTitle: documents.title, docPath: documents.path,
    distance: sql<number>`${chunks.embedding} <=> ${lit}::halfvec`
  })
    .from(chunks)
    .innerJoin(documents, eq(chunks.sourceId, documents.id))
    .where(and(eq(chunks.sourceType, 'document'), live(), projectFilter))
    .orderBy(sql`${chunks.embedding} <=> ${lit}::halfvec`)
    .limit(opts.limit ?? 10)
  return rows as ChunkHit[]
}
```
> Neighbour expansion (`expand` → also fetch `ord±1` for each hit) is optional; leave a `// TODO(expand)` only if you implement it later — do NOT ship a referenced-but-missing branch. For this cycle, `expand` is accepted but unused (documented in the spec follow-ons).

Correction: do not leave a TODO. If `expand` is not implemented now, **remove the `expand` option** from the signature entirely so there's no dead param. Final signature: `searchPassages(q, opts: { project?: string, limit?: number })`.

- [ ] **Step 4: Typecheck + tests**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add shared/types/documents.ts server/services/documents.ts
git commit -m "feat(search): chunk-aware searchDocs (collapsed) + searchPassages"
```

---

### Task 10: MCP `search_passages` tool

**Files:**
- Modify: `server/lib/agent/tools.ts` (add a tool to the `agentTools` array)

- [ ] **Step 1: Add the tool**

Add `searchPassages` to the imports from the documents service at the top of `server/lib/agent/tools.ts`, then add this object to the `agentTools` array (next to `search_docs`, ~line 79):
```typescript
{
  name: 'search_passages',
  description: 'Semantic search returning chunk-level passages (with parent document title/path) — use for precise RAG context instead of whole documents. Pass `project` (a slug) to scope.',
  kind: 'read',
  schema: { query: z.string().describe('Search query'), project: z.string().optional().describe('Project slug to scope to'), limit: z.number().optional().describe('Max passages (default 10)') },
  handler: async (a) => {
    const res = await searchPassages(a.query as string, { project: a.project as string | undefined, limit: a.limit as number | undefined })
    return { result: res, summary: `searched passages (${Array.isArray(res) ? res.length : 0})` }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (tool auto-registers via `buildMcpServer()`).

- [ ] **Step 3: Commit**
```bash
git add server/lib/agent/tools.ts
git commit -m "feat(mcp): search_passages tool for chunk-level RAG retrieval"
```

---

### Task 11: Long image OCR through the primitive

**Files:**
- Modify: `server/services/image-enrich.ts` (after the summary embed, ~line 108-122)

- [ ] **Step 1: Chunk long OCR**

In `server/services/image-enrich.ts`, add the import:
```typescript
import { chunkAndEmbedSource } from '../lib/chunking/embed-source'
import { estimateTokens } from '../lib/chunking/chunk-markdown'
```
After the image row is updated with the summary embedding (after the `db.update(images).set({...}).returning()` block, ~line 122), add:
```typescript
  // Long OCR → chunk into the shared primitive (short OCR stays summary-only).
  if (result.ocrText && estimateTokens(result.ocrText) > 512) {
    try {
      await chunkAndEmbedSource({ sourceType: 'image', sourceId: id, title: result.summary || null, body: result.ocrText })
    } catch (err) {
      console.warn(`[image-enrich] OCR chunking failed for ${id}:`, (err as Error).message)
    }
  }
```

- [ ] **Step 2: Wire image OCR chunks into `searchImages`**

In `server/services/images.ts`, in `searchImages`’ vector lane, add a second source of vector ids from `chunks` where `source_type='image'`, collapsed to image ids, and include it as an extra RRF lane alongside the existing summary-embedding lane. (Mirror the chunk query from Task 9 Step 2, swapping `'document'`→`'image'` and joining `images`.) Keep the summary-embedding lane intact.

- [ ] **Step 3: Typecheck + tests**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**
```bash
git add server/services/image-enrich.ts server/services/images.ts
git commit -m "feat(images): chunk long OCR through the shared primitive + fuse into searchImages"
```

---

### Task 12: E2E validation + docs

**Files:**
- Create/Modify: `docs/wiki/search.md` (chunking section), `docs/handovers/2026-06-17-document-chunking.md`

- [ ] **Step 1: E2E with playwright-cli** (browser-testing skill / project rule)

Register/login a dev user. Create a markdown document larger than 16k tokens (paste a long .md). Trigger embedding: call the admin `embed-run` route (or wait for the `*/5` cron). Then:
- Semantic-search a phrase that only appears deep in the doc via the command palette → the doc appears (was impossible before — proves the fix).
- Via MCP / agent, call `search_passages` for the same phrase → returns the relevant chunk with `docTitle`/`docPath`.
Capture a screenshot of the successful search.

- [ ] **Step 2: Verify chunk rows**

Confirm `SELECT count(*) FROM chunks WHERE source_type='document'` is non-zero and `documents.chunked_hash` is set for processed docs; confirm no repeated "poison doc" warnings in logs.

- [ ] **Step 3: Update wiki + write handover**

Update `docs/wiki/search.md` with the chunking pipeline (chunks table, contextualization, two retrieval paths). Write `docs/handovers/2026-06-17-document-chunking.md` with accurate frontmatter (what shipped, Task 1 spike findings, deferred follow-ons: contextual BM25, reranker enable, drop `documents.embedding`).

- [ ] **Step 4: Run full gates**

Run: `pnpm typecheck && pnpm vitest run && pnpm build && pnpm db:migrate`
Expected: all PASS.

- [ ] **Step 5: Commit**
```bash
git add docs/
git commit -m "docs(chunking): wiki + handover for document chunking + contextual retrieval"
```

---

## Self-Review

**Spec coverage:** chunks table (T2) ✓; pure chunker w/ size/overlap/atomic-blocks (T3) ✓; contextual retrieval resilient+flagged (T4/T5) ✓; prompt-caching de-risk (T1 spike + sequential contextualize in T6) ✓; reworked runEmbedding + auto-backfill via `chunked_hash` (T7) ✓; `searchDocs` collapsed + `searchPassages` (T8/T9) ✓; MCP `search_passages` (T10) ✓; long image OCR (T11) ✓; additive migration + HNSW (T2) ✓; tests TDD (T3/T5/T8) + integration/E2E (T12) ✓; follow-ons documented (T12 handover) ✓.

**Placeholder scan:** No "TBD/TODO" left — the `expand` param was explicitly removed in T9 Step 3 rather than stubbed. All code steps show complete code.

**Type consistency:** `chunkMarkdown`/`Chunk`/`estimateTokens` (T3) used consistently in T6/T11; `chunkAndEmbedSource` signature (T6) matches calls in T7/T11; `collapseChunksToSources` (T8) takes `{sourceId}[]` and is called with chunk rows in T9; `ChunkHit` (T9) returned by `searchPassages` and used by the T10 tool; `getChunkingConfig` fields (T4) match usage in T6.

**Open dependency:** Task 1 sets `embedBatch` (TEI `max_client_batch_size`) and the contextual-on/off backfill decision — the default `embedBatch: 32` and `contextual: true` are safe placeholders if the spike is inconclusive.
