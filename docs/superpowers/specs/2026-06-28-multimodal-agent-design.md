---
title: Multimodal agent — image + file attachments (Qwen3.6 VLM; files via PDF→image render)
status: approved (revised 2026-06-29 — files mechanism changed from "native file parts" to PDF→image render after the vLLM finding below)
date: 2026-06-28
cycle: 39
related:
  - docs/superpowers/specs/2026-06-26-qwen-image-edit-design.md (cycle 38 — edit_image; this adds the attachment source)
  - docs/wiki/agent.md (agent surface), docs/wiki/clipboard.md (the attachment-input UX to mirror)
  - AI SDK v6 (ai@6.0.198) multimodal message parts; Qwen3.6-35B-A3B natively multimodal VLM
---

# Multimodal agent — image + file attachments

Let Tony attach images and files to the `/agent` chat (paste / drag / file-picker, like the
clipboard input). The reasoning model — **Qwen3.6-35B-A3B, which is natively multimodal** — sees
the attachment as a message **content part** and, from the prompt, **decides what to do**: reason
over it ("what's in this?", "summarize this PDF") or call a tool (e.g. `edit_image` to edit an
attached photo). No separate vision model, no `analyze_image` tool, no per-turn model routing — the
agent's existing brain handles it.

## The serving-stack constraint that shapes this (READ FIRST)

Qwen3.6 is a VLM, but the model only ever receives what the **serving stack** (LiteLLM → vLLM)
forwards. vLLM's OpenAI-compatible API forwards **`image_url` / `video_url` / `audio_url`** content
parts only — there is **no generic file/document content part**. So we cannot hand the model a PDF
as a `file` part (the original "native file parts" idea is infeasible on this stack).

**Resolution — everything the model sees is an image or text part:**
- **Images** → a native `image_url` part (the VLM sees the picture). Certain.
- **Files** → converted server-side to something the model *can* ingest:
  - **PDF** → **rendered to page images** (first N pages → webp) → one `image_url` part per page. The
    VLM literally *sees* the document — layout, figures, scans, tables — not just stripped text.
  - **Plain-text / code** (`text/*`, `application/json`, csv, common code mimes) → decoded UTF-8 →
    a **text part** (no render needed; cheaper + lossless for text).
  - **Other binary** (docx, xlsx, zip, …) → **rejected at the composer** with a clear message;
    deferred (office→PDF conversion is a follow-on).

So the agent message only ever carries **text parts + image parts** — exactly what vLLM forwards.
There is no `file` content-part type anywhere in our pipeline.

**The model must receive BYTES, not a URL.** `/api/images/<id>/raw` (and the new files endpoint) are
auth-gated and internal; the self-hosted model behind LiteLLM can't fetch them. Image parts carry the
**bytes inline (base64 data URL)**, read server-side from storage at message-build time. Rendered PDF
pages are likewise inline base64 webp.

## Background / why this shape

- The agent pipeline is **text-only today**: `AgentMessage.content` is a `string`, and `ws.ts`'s
  text frame carries only `{ text, speak }`. Making it multimodal is almost entirely *our* plumbing.
- AI SDK v6 (`ai@6.0.198`, already installed) supports multimodal user messages: `content` as an
  array of parts. We use only `{ type:'text', text }` and `{ type:'image', image }`.
- Qwen3.6-35B-A3B (the `reasoning` model) is a unified MoE VLM with a vision encoder; it ingests
  images natively (beats the standalone Qwen3-VL on VL benchmarks).
- `sharp` is already a dependency and bundles cleanly in this Nuxt/Nitro build with no special
  config, so adding a pure-JS PDF→image renderer (`pdf-to-img`: pdfjs + prebuilt `@napi-rs/canvas`)
  + `sharp`→webp is proven-feasible and needs **no infra change** (no apt/poppler on the box).

## Architecture

### Content parts (the core change)
`server/lib/agent/run.ts` + `types.ts`:
- `AgentMessage.content: string | AgentContentPart[]` where
  `AgentContentPart = { type:'text'; text:string } | { type:'image'; image:string /*base64 data url*/; mediaType:string }`.
  (No `file` part — files become image or text parts before they reach a message.)
- `runAgent` maps each message to the AI SDK shape for `streamText` via `toModelContent`: a string
  stays a string; an array maps to `[{type:'text',text}, {type:'image', image:<dataUrl>}]`. The
  cycle-37 `redactImageUrlsForModel` applies to **text parts only**.
- Everything downstream that assumes `content: string` (history concat, persistence) handles the
  array via a `messageText(content)` helper (joins text parts; ignores image parts) for display/log.

### PDF→image renderer
`server/lib/agent/pdf-render.ts` (pure, never-throws):
- `renderPdfToImages(bytes: Buffer, opts?: { maxPages?: number; maxEdge?: number }): Promise<{ bytes: Buffer; mime: 'image/webp' }[]>`
  — render up to `maxPages` (default 8) pages with `pdf-to-img`, downscale each so its longest edge
  ≤ `maxEdge` (default 1600) and re-encode to webp with `sharp`, return the page images in order.
  On any failure (corrupt PDF, render error, missing native binding) return `[]` — never throw.
- Caps (page count + resolution) keep token/cost bounded; surfacing them in `/settings` is deferred.

### Attachment upload + transport
- **Composer** (`app/components/voice/Composer.vue`): add paste / drag-drop / a file-picker button
  for images + files (mirror the clipboard input's idiom). Selected attachments show as removable
  preview chips (image thumbnail / file name+size) before send. Cap count + per-file size, and
  reject unsupported file types (anything not an image, PDF, or text-like file) with a toast.
- On send, each attachment is uploaded over HTTP and the turn references the results:
  - images → existing `POST /api/upload` (sharp→webp, gallery row) → `{ id, kind:'image', url, mime }`.
  - files → new `POST /api/agent/files` (raw blob via `storage().put`, no image processing) →
    `{ id, kind:'file', mime, name, size }`. (The original PDF/text blob is stored as-is so the
    transcript's download chip serves the real file; rendering happens later, at message-build time.)
- The composer then sends the WS turn: `{ type:'text', text, speak, attachments: [{ id, kind, mime, name? }] }`.

### WS + orchestrator → multimodal message
- `ws.ts` accepts `attachments` on the `text` control frame and passes them to the turn.
- The turn builds the user `AgentMessage` via `buildUserMessageParts(text, attachments, readBytes, renderPdf)`:
  a `text` part for `text`, then per attachment —
  - image → one `image` part (bytes inline base64).
  - file + `application/pdf` → `renderPdf(bytes)` → one `image` part per rendered page (or, if render
    yields nothing, a `[attachment unavailable: name]` text note).
  - file + text-like mime → decode UTF-8 → a `text` part (`[file <name>]:\n<contents>`).
  - file + unsupported mime → a `[unsupported file: name]` text note (defensive; the composer should
    have already rejected it).
  - unreadable bytes → a `[attachment unavailable]` text note; never throw the turn.
- `ToolContext` gains `attachmentImageIds?: string[]` (the **image** attachments of the turn — used
  by `edit_image`; PDFs/text files are not edit sources). Threaded through `buildAiTools`.

### Edit-from-attachment
- `edit_image`'s source resolution: if `source_image_id` is omitted, use the turn's **attachment
  image** (from `ctx.attachmentImageIds`, newest) when present; else fall back to the newest
  generated image (cycle-38 behavior). So "make the hat blue" on an attached photo edits the photo.
- `resolveSourceImageId` gains an optional `preferIds?: string[]` (the attachment ids, checked live
  first); the tool passes `ctx.attachmentImageIds`.

### Persist + reload rendering
- Migration: `conversation_messages.attachments jsonb` (`[{ id, kind, mime, name?, url? }]`) + a new
  `agent_files` table for file blobs.
- On persist (`appendMessages`), the user turn records its `attachments`.
- `getAgentHistory` / the message DTO returns `attachments`; on reload the **transcript renders user
  attachments** — image thumbnails (`/api/images/<id>/raw`, authed UI) and a file chip (name +
  `/api/agent/files/<id>` download link) — alongside the user text. (`Transcript.vue` user branch
  gains an attachments row.) PDFs render as a download chip, NOT page thumbnails (v1).
- Live: the composer's pre-send preview + the user-turn echo show the same.
- History to the model: re-sending full image bytes (and re-rendering PDFs) every turn is costly.
  **v1: include attachment content only for the CURRENT turn**; in prior turns, attachments are
  represented to the model as a text note (`[attached image]` / `[attached file: name]`) — the model
  already reasoned over them when they were current, and `edit_image` targets by id, not by
  re-vision. (Re-attaching for follow-up vision is a documented limitation; full multi-turn image
  memory is deferred.)

### The model decides
Qwen3.6 receives the prompt + attachment parts (image / rendered-PDF pages / text) and either answers
(infer) or calls a tool. The cycle-37/38 reliable-render for *generated/edited* images is unchanged
(model still gets no URL for those; server authors their embed; history urls redacted). User-*attached*
images and rendered PDF pages are input parts carrying inline bytes — a separate path from
generated-image output.

## Data flow

```
composer: text + [img.png, doc.pdf]
  → upload img → /api/upload → {id:G1, kind:image}; upload pdf → /api/agent/files → {id:F1, kind:file}
  → WS {type:'text', text, attachments:[{id:G1,kind:image,mime}, {id:F1,kind:file,mime:application/pdf,name}]}
ws.ts → handleTurn(text, attachments)
  → buildUserMessageParts:
      [{type:text,text},
       {type:image, image:<base64 G1>},
       {type:image, image:<base64 page1 of F1>}, {type:image, image:<base64 page2 of F1>}, …]
  → runAgent(messages with parts, ctx.attachmentImageIds=[G1])
  → Qwen3.6 sees photo + PDF pages + text → answers OR calls edit_image (source defaults to G1)
  → persist user msg with attachments:[{id:G1,...},{id:F1,...}] ; reload renders thumbnail + file chip
```

## Error handling
- Upload failure → composer shows the error, doesn't send the turn (or sends text-only with a note).
- Unreadable attachment bytes at build time → skip that part + a text note `[attachment unavailable]`; never throw the turn.
- PDF render yields no pages (corrupt / render error) → `[attachment unavailable: name]` text note; the turn still sends.
- Oversized / too many / unsupported-type attachments → composer rejects before upload (configurable caps + type allow-list).

## Testing
Unit:
- `renderPdfToImages` (real one-page PDF fixture): returns ≥1 webp buffer (RIFF…WEBP magic); a
  corrupt/empty buffer returns `[]` (never throws); `maxPages` caps the count.
- `buildUserMessageParts(text, attachments, readBytes, renderPdf)` (pure, mocked reads + render):
  text-only → string; text+image → parts with base64 image; text+PDF → text part + one image part
  per rendered page; text+text-file → a text part with the file contents; unreadable → text-note
  fallback; PDF render `[]` → `[attachment unavailable]` note.
- `messageText(content)` helper: string passthrough; parts → joined text (image parts ignored).
- `toModelContent` mapping: array content → AI SDK parts; redaction applies to text parts only;
  string content unchanged (regression).
- `resolveSourceImageId(explicit, { preferIds })`: preferIds (attachment) wins over newest-generated;
  falls back when absent.
- `edit_image` handler: with `ctx.attachmentImageIds`, edits the attachment; without, newest-generated.
- files endpoint handler (stores blob, returns ref); `getFileBytes` round-trip.

Live (post-merge, against the rig):
1. Sanity: an `image_url` part round-trips through LiteLLM→vLLM→Qwen3.6 (near-certain for a VLM; if
   this fails the whole feature is impossible — quick check, not a build gate).
2. Attach a photo + "what is this?" → the model describes it (native vision).
3. Attach a photo + "make the sky purple" → `edit_image` edits the ATTACHED photo, renders inline.
4. Attach a PDF + "summarize this" → the model summarizes from the rendered page images.
5. Attach a multi-page PDF → pages beyond the cap are dropped (documented), the rest are summarized.
6. Reload the conversation → user attachments re-render as thumbnails / file chips.
7. Upload failure / oversized / unsupported type → clean composer error, no crash.

## Acceptance criteria
- Paste/drag/attach images + files in `/agent`; they preview, upload, and send with the turn.
- The model reasons over an attached image OR a PDF (rendered to page images) OR a text file (infer),
  OR edits an attached image (`edit_image` source = the attachment), chosen from the prompt — no
  separate vision tool or model routing.
- Files reach the model only as image parts (PDF pages) or text parts (text files); no `file` part
  is ever sent (vLLM can't forward it).
- Attachments persist on the message and re-render on reload.
- No regression to text-only turns, generated-image render, or the cycle-37/38 reliable-render.

## Deferred (documented, not built)
- **Multi-turn image memory** (re-sending attachment images / re-rendering PDFs for follow-up vision
  on a prior turn).
- **Office/binary docs** (docx, xlsx, …) — rejected in v1; needs an office→PDF (or →text) conversion.
- **Audio / video** attachments (Qwen3.6 supports video; out of scope here).
- **PDF page thumbnails in the transcript** (v1 shows a file download chip, not rendered pages).
- **Render caps in `/settings`** (maxPages / resolution are constants in v1).
- **Promoting file attachments into the searchable doc library** (chunk/embed) — v1 stores the blob
  + lets the model read it; library ingestion is a follow-on.
- **AI SDK v7 upgrade** (canonical file model + provider file caching) — separate migration cycle.
- **Multi-image edit compositing** (cycle-38 deferral, unchanged).
