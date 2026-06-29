# Multimodal Agent (image + file attachments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Tony attach images + files to the `/agent` chat; the natively-multimodal reasoning model (Qwen3.6 VLM) sees them as message content parts and decides — reason over them, or call `edit_image` on an attached image.

**Architecture:** Make `AgentMessage.content` support content parts (**text + image only**); the composer uploads attachments over HTTP then sends the turn over the WS with attachment refs; the orchestrator reads the bytes and builds a multimodal user message — **images inline as base64 image parts; PDFs rendered server-side to page images (image parts); text files decoded to text parts** (the self-hosted model behind vLLM forwards only `image_url`/text, never a file part, and can't fetch our auth-gated URLs); `runAgent` maps parts to AI SDK v6 `streamText`; `edit_image` defaults its source to the turn's attachment; attachments persist on the message and re-render on reload.

**Tech Stack:** Nuxt 4 / Nitro, AI SDK v6 (`ai@6.0.198`) multimodal message parts, `pdf-to-img` (pdfjs + prebuilt `@napi-rs/canvas`) + `sharp` for PDF→image, Drizzle (migration), Vitest, Nuxt UI v4, crossws (the agent WS).

## Why files are rendered to images (the load-bearing constraint)

vLLM's OpenAI-compatible API forwards only `image_url` / `video_url` / `audio_url` content parts — **there is no generic file/document part**. So the model cannot receive a PDF as a `file` part. Everything the model sees is therefore an **image part or a text part**:
- image attachment → native image part.
- PDF → rendered to page images (webp) → image parts (the VLM *sees* the document).
- text-like file (`text/*`, `application/json`, csv, common code) → decoded → text part.
- other binary (docx/xlsx/zip/…) → rejected at the composer (deferred).

There is **no `file` content-part type** anywhere in this plan. (Earlier drafts assumed "native file parts" — that path is dead; see the spec's "serving-stack constraint" section.)

## Optional live sanity check (controller, NOT a build gate)
Before/after the build, confirm an `image_url` part round-trips through LiteLLM→vLLM→Qwen3.6 (near-certain for a VLM serving stack). If it ever failed, the whole feature is impossible — but it does not branch the plan, so it is a quick check folded into live acceptance, not a blocking prerequisite.

## Global Constraints

- **The model gets BYTES, not URLs.** Image parts carry base64 data read server-side from storage; never an `/api/images/<id>/raw` URL (auth-gated + unreachable by the model). Rendered PDF pages are inline base64 webp too.
- **Files become images or text — never a `file` part.** `AgentContentPart` is `text | image` only. PDFs render to image parts; text files decode to text parts; unsupported types are rejected upstream.
- AI SDK v6 user-message parts used: `{ type:'text', text }`, `{ type:'image', image: <dataURL string> }`. `runAgent` already maps `messages`→`streamText`; extend that map.
- The cycle-37 `redactImageUrlsForModel` applies to **text parts only**. The cycle-37/38 reliable-render for *generated* images is unchanged (generated images: model gets no URL, server authors the embed). User *attachments* are a separate input path.
- v1: send attachment content only for the **current** turn; prior-turn attachments are text notes (`getAgentHistory` stays text-only). Multi-turn image memory is deferred.
- `edit_image` defaults its source to the turn's attachment **image** when present, else newest-generated (cycle-38). PDFs/text files are never edit sources.
- PDF render caps (page count + resolution) are constants in v1 (not `/settings`); the renderer never throws (returns `[]` on failure).
- **Package manager `pnpm`.** Gates: typecheck + test + build. Lint red repo-wide — NOT a gate. App under `app/`, server under `server/`.
- **Every dispatch carries a file allow-list + "ADD/EDIT, don't delete to pass a gate" + a pre-commit `git status --short` scope check.** (Cycle-37 lesson.)

### Verified facts (trust these)
- `AgentMessage` = `{ role: 'system'|'user'|'assistant'; content: string }` (`server/lib/agent/run.ts:13`). `runAgent` maps messages at `run.ts:73` (currently applies `redactImageUrlsForModel` to assistant content).
- `redactImageUrlsForModel(text)` + `applyImageEmbeds` live in `server/lib/agent/image-embed.ts`.
- `ToolContext` = `{ signal; requestApproval? }` (`server/lib/agent/types.ts`). `buildAiTools(registry, hooks)` builds `ctx` (`ai-tools.ts:24`).
- `handleTurn(userText, history, deps)` (`server/lib/voice/orchestrator.ts`) assembles the turn; `ws.ts` `message()` handles the `{type:'text', text, speak}` control frame and calls `handleTurn`.
- `appendMessages(convId, msgs[{role,content,modality,toolCalls}])` + `getAgentHistory` (returns `{role,content}[]`) + the `ConversationMessage` DTO (`conversations.ts`). `conversation_messages` cols: content, modality, toolCalls (jsonb) — schema `server/db/schema/conversations.ts`.
- `POST /api/upload` → `createImage` → an image row (id + servable). `serveUrl(row)` → `/api/images/<id>/raw`. `getImageBytes(id)` → `{bytes, mime}|null` (`services/images.ts`, cycle 37). Mirror `server/api/upload.post.ts` for multipart parsing.
- `resolveSourceImageId(explicitId)` (cycle 38) → newest-generated when null. `edit_image` calls it.
- Composer: `app/components/voice/Composer.vue` (text + `sendText`). Transcript: `app/components/voice/Transcript.vue` (user = plain `<p>`, assistant = `MdView`).
- `sharp` already bundles in this build with no special Nitro config; native node modules are auto-externalized by the node-server preset. If `pnpm build` ever fails resolving `@napi-rs/canvas`/`pdfjs-dist`, add them to `nitro.externals` (mirror how a native dep would be handled) — but expect it to work out of the box like sharp.

---

### Task 1: Content parts on `AgentMessage` + `runAgent` mapping

**Files:** Modify `server/lib/agent/run.ts`, `server/lib/agent/types.ts`; Test `server/lib/agent/content-parts.test.ts`

**Interfaces produced:**
- `AgentContentPart = { type:'text'; text:string } | { type:'image'; image:string; mediaType:string }`
- `AgentMessage.content: string | AgentContentPart[]`
- `messageText(content: string | AgentContentPart[]): string` (joins text parts; ignores image parts) — exported from run.ts.
- `toModelContent(role, content): unknown` (maps to AI SDK content; redaction on text only) — exported from run.ts.

- [ ] **Step 1: Failing test** — `server/lib/agent/content-parts.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { messageText, toModelContent } from './run'
import type { AgentContentPart } from './run'

describe('messageText', () => {
  it('passes a string through', () => { expect(messageText('hi')).toBe('hi') })
  it('joins text parts and ignores image parts', () => {
    const parts: AgentContentPart[] = [
      { type: 'text', text: 'look at this' },
      { type: 'image', image: 'data:image/webp;base64,AAAA', mediaType: 'image/webp' }
    ]
    expect(messageText(parts)).toBe('look at this')
  })
})

describe('toModelContent', () => {
  it('maps parts to AI SDK shape (image preserved, text redaction applied for assistant)', () => {
    const out = toModelContent('assistant', [
      { type: 'text', text: 'see ![x](/api/images/y/raw)' },
      { type: 'image', image: 'data:image/webp;base64,AAAA', mediaType: 'image/webp' }
    ]) as AgentContentPart[]
    expect(out[0]).toEqual({ type: 'text', text: 'see [image]' })   // redaction on text part
    expect(out[1]).toMatchObject({ type: 'image' })
  })
  it('redacts a plain string assistant message', () => {
    expect(toModelContent('assistant', '![x](/api/images/y/raw)')).toBe('[image]')
  })
  it('does NOT redact a user text part', () => {
    const out = toModelContent('user', [{ type: 'text', text: 'see ![x](/api/images/y/raw)' }]) as AgentContentPart[]
    expect(out[0]).toEqual({ type: 'text', text: 'see ![x](/api/images/y/raw)' })
  })
})
```

- [ ] **Step 2: Run → fail** (`pnpm vitest run server/lib/agent/content-parts.test.ts`).

- [ ] **Step 3: Implement** — in `types.ts` add `AgentContentPart` (export). In `run.ts`:
  - Change `AgentMessage` to `{ role: ...; content: string | AgentContentPart[] }` and re-export `AgentContentPart` (`export type { AgentContentPart } from './types'`).
  - Add (import `redactImageUrlsForModel` from `./image-embed` — already imported there for the current `run.ts:73` redaction):

```ts
export function messageText(content: string | AgentContentPart[]): string {
  return typeof content === 'string'
    ? content
    : content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n')
}

/** Map our content → AI SDK message content for streamText. Redaction applies to text only. */
export function toModelContent(role: AgentMessage['role'], content: string | AgentContentPart[]): unknown {
  const redact = (t: string) => role === 'assistant' ? redactImageUrlsForModel(t) : t
  if (typeof content === 'string') return redact(content)
  return content.map(p => p.type === 'text'
    ? { type: 'text', text: redact(p.text) }
    : { type: 'image', image: p.image })
}
```
  - At `run.ts:73`, replace the existing `.map(...)` redaction with:
    `messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: toModelContent(m.role, m.content) }))`
    (keep whatever system-message handling already exists around it — only the user/assistant map changes).

- [ ] **Step 4: Run → pass.** `pnpm typecheck` → fix any `content: string` assumers via `messageText(...)` (the orchestrator's assistant-text accumulation reads stream deltas, not message content — likely no change; `chat.post.ts` builds string messages — unchanged). Confirm 0 errors.

- [ ] **Step 5: Commit** `feat(agent): content parts (text|image) on AgentMessage + streamText mapping`.

---

### Task 2: PDF→image renderer

**Files:** Create `server/lib/agent/pdf-render.ts`, `server/lib/agent/__fixtures__/sample.pdf`; Test `server/lib/agent/pdf-render.test.ts`. Add dep `pdf-to-img`.

**Interfaces produced:**
- `renderPdfToImages(bytes: Buffer, opts?: { maxPages?: number; maxEdge?: number }): Promise<{ bytes: Buffer; mime: 'image/webp' }[]>` — renders up to `maxPages` (default 8) pages, each downscaled so its longest edge ≤ `maxEdge` (default 1600) and re-encoded to webp; returns the pages in order. Never throws (returns `[]` on any failure).

- [ ] **Step 1: Add the dependency.** `pnpm add pdf-to-img` (pulls `pdfjs-dist` + `@napi-rs/canvas`, both ship prebuilt binaries for linux-x64 + macos, same model as the existing `sharp`).

- [ ] **Step 2: Create the fixture** `server/lib/agent/__fixtures__/sample.pdf` — a minimal one-page PDF that draws a filled rectangle (pdfjs parses hand-written PDFs via recovery mode, so an exact xref/`/Length` is not required):

```
%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>
endobj
4 0 obj
<< /Length 31 >>
stream
0 0 0 rg 40 40 120 120 re f
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF
```

- [ ] **Step 3: Failing test** — `server/lib/agent/pdf-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderPdfToImages } from './pdf-render'

const sample = readFileSync(fileURLToPath(new URL('./__fixtures__/sample.pdf', import.meta.url)))
const isWebp = (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'

describe('renderPdfToImages', () => {
  it('renders a one-page PDF to a webp image', async () => {
    const out = await renderPdfToImages(sample)
    expect(out.length).toBe(1)
    expect(out[0].mime).toBe('image/webp')
    expect(isWebp(out[0].bytes)).toBe(true)
  })
  it('respects maxPages', async () => {
    const out = await renderPdfToImages(sample, { maxPages: 0 })
    expect(out.length).toBe(0)
  })
  it('returns [] for a non-PDF buffer (never throws)', async () => {
    const out = await renderPdfToImages(Buffer.from('not a pdf'))
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 4: Run → fail** (`pnpm vitest run server/lib/agent/pdf-render.test.ts`).

- [ ] **Step 5: Implement** `server/lib/agent/pdf-render.ts`:

```ts
import sharp from 'sharp'

const DEFAULT_MAX_PAGES = 8
const DEFAULT_MAX_EDGE = 1600

/**
 * Render the first N pages of a PDF to webp images so a vision model can SEE the document
 * (vLLM forwards image parts only — no file part). Pure + never-throws: returns [] on any
 * failure (corrupt PDF, render/native error). Caps page count + resolution to bound tokens.
 */
export async function renderPdfToImages(
  bytes: Buffer,
  opts: { maxPages?: number; maxEdge?: number } = {}
): Promise<{ bytes: Buffer; mime: 'image/webp' }[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  const maxEdge = opts.maxEdge ?? DEFAULT_MAX_EDGE
  if (maxPages <= 0) return []
  const out: { bytes: Buffer; mime: 'image/webp' }[] = []
  try {
    const { pdf } = await import('pdf-to-img')
    const doc = await pdf(new Uint8Array(bytes), { scale: 2 })
    for await (const pagePng of doc) {
      const webp = await sharp(pagePng)
        .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()
      out.push({ bytes: webp, mime: 'image/webp' })
      if (out.length >= maxPages) break
    }
  } catch {
    return []
  }
  return out
}
```
> If `pnpm build` later fails to bundle `@napi-rs/canvas`/`pdfjs-dist`, add them to `nitro.externals` in `nuxt.config.ts` (they're native/ESM, externalize like sharp). Don't pre-add it unless build fails.

- [ ] **Step 6: Run → pass.** `pnpm typecheck` 0. (If the fixture won't render under pdfjs recovery mode, adjust the fixture to a minimal but valid PDF — the test must prove a real render, not a mock.)
- [ ] **Step 7: Commit** `feat(agent): PDF→image renderer (pdf-to-img + sharp→webp, capped, never-throws)`.

---

### Task 3: `buildUserMessageParts` (assemble a multimodal user turn)

**Files:** Create `server/lib/agent/attachments.ts`; Test `server/lib/agent/attachments.test.ts`

**Interfaces:**
- Consumes: `AgentContentPart` (Task 1); `renderPdfToImages` (Task 2); injected byte reader.
- Produces:
  - `AttachmentRef = { id:string; kind:'image'|'file'; mime:string; name?:string }`
  - `isTextLikeMime(mime: string): boolean` (`text/*`, `application/json`, csv, common code mimes)
  - `buildUserMessageParts(text, attachments, readBytes, renderPdf?): Promise<string | AgentContentPart[]>`
    where `readBytes: (a: AttachmentRef) => Promise<{ bytes: Buffer; mime: string } | null>` and
    `renderPdf` defaults to `renderPdfToImages`.

- [ ] **Step 1: Failing test** — `attachments.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildUserMessageParts } from './attachments'

const readImg = vi.fn(async () => ({ bytes: Buffer.from([1, 2, 3]), mime: 'image/webp' }))

describe('buildUserMessageParts', () => {
  it('no attachments → plain string', async () => {
    expect(await buildUserMessageParts('hi', [], readImg)).toBe('hi')
  })
  it('image attachment → text + base64 image part', async () => {
    const out = await buildUserMessageParts('look', [{ id: 'g1', kind: 'image', mime: 'image/webp' }], readImg) as any[]
    expect(out[0]).toEqual({ type: 'text', text: 'look' })
    expect(out[1].type).toBe('image')
    expect(out[1].image).toMatch(/^data:image\/webp;base64,/)
  })
  it('PDF attachment → one image part per rendered page', async () => {
    const readPdf = vi.fn(async () => ({ bytes: Buffer.from([9]), mime: 'application/pdf' }))
    const renderPdf = vi.fn(async () => [
      { bytes: Buffer.from([1]), mime: 'image/webp' as const },
      { bytes: Buffer.from([2]), mime: 'image/webp' as const }
    ])
    const out = await buildUserMessageParts('summarize', [{ id: 'f1', kind: 'file', mime: 'application/pdf', name: 'a.pdf' }], readPdf, renderPdf) as any[]
    expect(out.filter(p => p.type === 'image').length).toBe(2)
    expect(out[1].image).toMatch(/^data:image\/webp;base64,/)
  })
  it('text file → text part with contents', async () => {
    const readTxt = vi.fn(async () => ({ bytes: Buffer.from('hello world', 'utf8'), mime: 'text/plain' }))
    const out = await buildUserMessageParts('what', [{ id: 't1', kind: 'file', mime: 'text/plain', name: 'n.txt' }], readTxt) as any[]
    const joined = out.filter(p => p.type === 'text').map(p => p.text).join('\n')
    expect(joined).toContain('hello world')
    expect(joined).toContain('n.txt')
  })
  it('PDF render yields nothing → unavailable note', async () => {
    const readPdf = vi.fn(async () => ({ bytes: Buffer.from([9]), mime: 'application/pdf' }))
    const out = await buildUserMessageParts('x', [{ id: 'f1', kind: 'file', mime: 'application/pdf', name: 'a.pdf' }], readPdf, async () => []) as any[]
    expect(out.some(p => p.type === 'text' && p.text.includes('[attachment unavailable'))).toBe(true)
  })
  it('unreadable attachment → text note, never throws', async () => {
    const out = await buildUserMessageParts('look', [{ id: 'x', kind: 'image', mime: 'image/webp' }], async () => null) as any[]
    expect(out.some(p => p.type === 'text' && p.text.includes('[attachment unavailable]'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `server/lib/agent/attachments.ts`:

```ts
import type { AgentContentPart } from './run'
import { renderPdfToImages } from './pdf-render'

export interface AttachmentRef { id: string; kind: 'image' | 'file'; mime: string; name?: string }

const TEXT_LIKE = /^text\//
const TEXT_LIKE_EXACT = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/x-yaml',
  'application/x-sh', 'application/csv', 'application/markdown'
])
export function isTextLikeMime(mime: string): boolean {
  return TEXT_LIKE.test(mime) || TEXT_LIKE_EXACT.has(mime)
}

type ReadBytes = (a: AttachmentRef) => Promise<{ bytes: Buffer; mime: string } | null>
type RenderPdf = (bytes: Buffer) => Promise<{ bytes: Buffer; mime: 'image/webp' }[]>

export async function buildUserMessageParts(
  text: string,
  attachments: AttachmentRef[],
  readBytes: ReadBytes,
  renderPdf: RenderPdf = (b) => renderPdfToImages(b)
): Promise<string | AgentContentPart[]> {
  if (!attachments.length) return text
  const parts: AgentContentPart[] = []
  if (text) parts.push({ type: 'text', text })
  const note = (name?: string) => parts.push({ type: 'text', text: `[attachment unavailable${name ? `: ${name}` : ''}]` })

  for (const a of attachments) {
    const got = await readBytes(a).catch(() => null)
    if (!got) { note(a.name); continue }
    const imagePart = (mime: string, bytes: Buffer) =>
      parts.push({ type: 'image', image: `data:${mime};base64,${bytes.toString('base64')}`, mediaType: mime })

    if (a.kind === 'image') { imagePart(got.mime, got.bytes); continue }
    // file:
    if (got.mime === 'application/pdf') {
      const pages = await renderPdf(got.bytes).catch(() => [])
      if (!pages.length) { note(a.name); continue }
      for (const pg of pages) imagePart(pg.mime, pg.bytes)
    } else if (isTextLikeMime(got.mime)) {
      parts.push({ type: 'text', text: `[file ${a.name ?? a.id}]:\n${got.bytes.toString('utf8')}` })
    } else {
      parts.push({ type: 'text', text: `[unsupported file: ${a.name ?? a.id}]` })
    }
  }
  return parts.length ? parts : text
}
```

- [ ] **Step 4: Run → pass.** `pnpm typecheck` 0.
- [ ] **Step 5: Commit** `feat(agent): buildUserMessageParts (image/PDF→images/text-file→text)`.

---

### Task 4: Files upload + byte-read endpoints (owns the migration)

**Files:** Create `server/api/agent/files.post.ts`, `server/api/agent/files/[id].get.ts`, `server/services/files.ts`, a schema file under `server/db/schema/`; Modify `server/db/schema/conversations.ts` (add `attachments` col); Test `test/agent-files.test.ts`

**Interfaces:**
- `saveFile(buffer: Buffer, mime: string, name?: string): Promise<{ id, mime, name, size }>` (stores raw blob via `storage().put` → insert `agent_files` row).
- `getFileBytes(id: string): Promise<{ bytes: Buffer; mime: string; name?: string } | null>` (read row → `storage().get` → buffer).
- `POST /api/agent/files` (multipart `file`) → `{ id, kind:'file', mime, name, size }`.
- `GET /api/agent/files/[id]` → streams the blob (auth-gated; for the UI download chip).

- [ ] **This task OWNS the migration.** Add BOTH schema changes now, then generate ONE migration:
  - (a) new `agent_files` table: `id uuid pk default gen_random_uuid()`, `storage_key text notNull`, `mime text notNull`, `name text`, `size integer notNull`, `created_at timestamptz notNull defaultNow()`.
  - (b) `attachments jsonb` (nullable) on `conversation_messages` (consumed by Task 5).
  Run `pnpm db:generate` → ONE migration file; `pnpm db:migrate` locally. (Task 5 only touches the service/DTO — no new migration.)
- [ ] Implement `server/services/files.ts` mirroring cycle-37 `getImageBytes`/storage usage: `saveFile` (`storage().put` → insert row → return `{id,mime,name,size}`); `getFileBytes` (select row → `storage().get(storage_key)` → buffer the stream → `{bytes,mime,name}`; null when missing).
- [ ] Endpoints (thin handlers; mirror `server/api/upload.post.ts` multipart parsing + the project's auth pattern): `POST /api/agent/files` → `saveFile` → ref; `GET /api/agent/files/[id]` → `getFileBytes` → `setResponseHeader('content-type', mime)` + return the buffer (auth-gated).
- [ ] Test `test/agent-files.test.ts`: `saveFile`/`getFileBytes` round-trip with mocked storage + DB; the POST handler returns the `{ id, kind:'file', mime, name, size }` ref shape.
- [ ] **Commit** `feat(agent): file attachment storage + upload/read endpoints (migration: agent_files + message attachments)`.

---

### Task 5: Persist attachments on messages (service + DTO)

**Files:** Modify `server/services/conversations.ts` (+ the `/api/conversations/[id]` handler if the DTO is shaped there); Test `test/conversations-attachments.test.ts`

> The `conversation_messages.attachments` column + migration were created in Task 4. This task is service/DTO only — NO new migration.

- [ ] `appendMessages`: accept `attachments?: AttachmentRef[]` on each msg, persist to the `attachments` column. Import `AttachmentRef` from `server/lib/agent/attachments`.
- [ ] The `ConversationMessage` DTO + the `/api/conversations/[id]` response include `attachments: AttachmentRef[] | null`.
- [ ] `getAgentHistory` UNCHANGED (stays `{role, content}` text-only — prior-turn attachments are not re-sent to the model in v1).
- [ ] Test: `appendMessages` persists `attachments` + the DTO returns them; a message with no attachments returns `null`/`[]` (regression).
- [ ] **Commit** `feat(conversations): persist + return message attachments`.

---

### Task 6: WS + orchestrator — accept attachments, build the multimodal turn, thread ToolContext

**Files:** Modify `server/api/voice/ws.ts`, `server/lib/voice/orchestrator.ts`, `server/lib/agent/run.ts` (ctx), `server/lib/agent/ai-tools.ts` (ctx), `server/lib/agent/types.ts` (ToolContext); Test `server/lib/voice/orchestrator-attachments.test.ts`

- [ ] `ToolContext` gains `attachmentImageIds?: string[]`; `buildAiTools` sets it from a new hook/deps field; `runAgent` ctx + `handleTurn` deps carry `attachments` / `attachmentImageIds`.
- [ ] `ws.ts`: the `text` frame reads `msg.attachments` (`AttachmentRef[]`, default `[]`); pass to `handleTurn`. The persisted user message records `attachments` (Task 5).
- [ ] `handleTurn`: build the user `AgentMessage` via `buildUserMessageParts(text, attachments, readAttachmentBytes)` where `readAttachmentBytes` dispatches `getImageBytes(id)` (kind image) / `getFileBytes(id)` (kind file). Set `ctx.attachmentImageIds = attachments.filter(a => a.kind === 'image').map(a => a.id)`.
- [ ] Test (fake `runAgent`): a turn with an image attachment → the user message passed to `runAgent` has an image part, and `attachmentImageIds` reaches the tool ctx; a text-only turn is unchanged (regression).
- [ ] `pnpm typecheck` 0; run agent + voice suites.
- [ ] **Commit** `feat(agent): WS attachments → multimodal turn + tool ctx`.

---

### Task 7: `edit_image` defaults to the turn's attachment

**Files:** Modify `server/services/images.ts` (`resolveSourceImageId` preferIds), `server/lib/agent/tools.ts` (edit_image); Test `test/edit-image-tool.test.ts` (extend)

- [ ] `resolveSourceImageId(explicitId, opts?: { preferIds?: string[] })`: if no explicit id, try `preferIds` (first that resolves to a live image) before newest-generated.
- [ ] `edit_image` handler: pass `{ preferIds: ctx.attachmentImageIds }` to `resolveSourceImageId`.
- [ ] Test: with `ctx.attachmentImageIds=['att1']` and no `source_image_id`, edits `att1`; without, newest-generated (regression).
- [ ] **Commit** `feat(agent): edit_image targets the attached image`.

---

### Task 8: Composer attachment UX

**Files:** Modify `app/components/voice/Composer.vue` (+ a small `useAgentAttachments` composable if cleaner); reference `app/components/clipboard/*` (the clipboard input) + `app/pages/agent/index.vue` (where Composer's `sendText` is wired) + `useVoice`.

- [ ] Add paste / drag-drop / a file-picker button (Nuxt UI) for images + files. Selected items show removable preview chips (image thumbnail / file name+size). Enforce caps (e.g. ≤4 attachments, ≤20 MB each) AND a **type allow-list** (images, `application/pdf`, text-like mimes) — reject others with a toast.
- [ ] On send: upload images → `POST /api/upload`, files → `POST /api/agent/files`; collect `AttachmentRef[]`; call `sendText(text, speak, attachments)` (extend the signature) which sends the WS frame with `attachments`. Clear the tray after send.
- [ ] Wire `app/pages/agent/index.vue` / `useVoice` so the WS `text` frame includes `attachments` end-to-end into `ws.ts`.
- [ ] Gate: `pnpm typecheck` 0 + `pnpm build`. (Consult `nuxt-ui-docs`/`browser-testing` skills; live playwright in Task 10.)
- [ ] **Commit** `feat(agent): composer image + file attachments`.

---

### Task 9: Render user attachments in the transcript

**Files:** Modify `app/components/voice/Transcript.vue` (+ the `TranscriptEntry`/message types to carry attachments); reference `useVoice`/`useConversations` for the reload path.

- [ ] The user-message branch renders an attachments row: image thumbnails (`<img src="/api/images/<id>/raw">`) and file chips (name + `/api/agent/files/<id>` download link), alongside the user text. (PDFs show as a file chip, not page thumbnails — v1.)
- [ ] Live: the composer's pre-send tray + the echoed user turn carry the attachments; on reload, `getConversation` messages include `attachments` (Task 5) → render them.
- [ ] Gate: typecheck 0 + build.
- [ ] **Commit** `feat(agent): render user attachments in the transcript`.

---

### Task 10: Final wiring verification + docs

**Files:** Modify `docs/wiki/agent.md`, `docs/superpowers/plans/00-roadmap.md`

- [ ] **Full gate:** `pnpm typecheck && pnpm vitest run && pnpm build` — report exact counts; STOP/BLOCKED on any failure (don't delete tests to pass).
- [ ] Confirm migration applies (`pnpm db:migrate` on a clean local DB).
- [ ] Wiki `agent.md`: a "Multimodal attachments" section — attach images/files in `/agent`; images native to Qwen3.6, PDFs rendered to page images (vLLM forwards image parts only), text files as text; model decides infer vs `edit_image` (source = attachment); persistence; the current-turn-only + render-caps caveats. Bump `cycle`/`updated` to 39 / 2026-06-29.
- [ ] Roadmap: cycle-39 row (✅ shipped), link spec/plan/handover (`../../handovers/2026-06-29-multimodal-agent.md` — controller writes it).
- [ ] **Commit** `docs(agent): multimodal attachments (cycle 39)`.

---

## Live verification (post-merge, against the rig — acceptance)
0. Sanity: an image_url part round-trips through LiteLLM→vLLM→Qwen3.6 (quick check).
1. Attach a photo + "what is this?" → native vision description.
2. Attach a photo + "make the sky purple" → `edit_image` edits the ATTACHED photo, renders inline.
3. Attach a PDF + "summarize this" → summary from the rendered page images.
4. Attach a multi-page PDF → pages past the cap dropped (documented); the rest summarized.
5. Reload the conversation → user attachments re-render (thumbnails + file chips).
6. Oversized/too-many/unsupported-type/upload-fail → clean composer error, no crash. Text-only turns unaffected.

## Self-review notes (spec coverage)
- Content parts (text|image) → T1. PDF→image renderer → T2. buildUserMessageParts (image/pdf/text) → T3. Files upload/read + migration → T4. Persist + DTO → T5. WS+orchestrator+ctx → T6. edit-from-attachment → T7. Composer UX → T8. Transcript render → T9. Gate+docs → T10.
- vLLM "image parts only" constraint → no `file` part type (T1), files→images/text (T2/T3), composer type allow-list (T8).
- Reliable-render unchanged; redaction on text parts only → T1.
- Deferred (multi-turn image memory, office docs, audio/video, PDF page thumbnails, render-caps-in-settings, file→doc-library, v7) → not built.
